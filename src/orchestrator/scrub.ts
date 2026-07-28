/**
 * Queue scrub: detect postings that closed while sitting in the pre-submit
 * queue (scored / awaiting_approval / approved / needs_human) and mark them
 * `skipped` so nobody preps materials for a dead job.
 *
 * Detection is CONSERVATIVE: a job is only closed on a definitive signal —
 * a 404/410 from the source's own API, absence from the source's live board,
 * or an explicit "no longer accepting" page. Network errors and ambiguity
 * leave the job untouched (better a stale row than a live job scrubbed).
 */
import { jobs, events } from "../store/repositories.js";
import type { JobPosting, JobStatus } from "../types/index.js";

const SCRUB_STATUSES: JobStatus[] = ["scored", "awaiting_approval", "approved", "needs_human"];

// Explicit closed-page phrasings; generic 200 pages without these stay open.
const CLOSED_SIGNATURES =
  /no longer (open|available|accepting|active)|position has been filled|job (posting )?(is )?closed|posting not found|job you (are looking for|requested).{0,40}(closed|not|found)/i;

type Verdict = "open" | "closed" | "unknown";

async function fetchStatus(url: string): Promise<{ status: number; body: string } | null> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
      headers: { accept: "application/json, text/html" },
    });
    const body = res.ok ? (await res.text()).slice(0, 200_000) : "";
    return { status: res.status, body };
  } catch {
    return null;
  }
}

/** 404/410 → closed; other statuses (403, 5xx, timeouts) prove nothing. */
function verdictFromApi(r: { status: number } | null): Verdict {
  if (!r) return "unknown";
  if (r.status === 404 || r.status === 410) return "closed";
  if (r.status >= 200 && r.status < 300) return "open";
  return "unknown";
}

// Ashby's job pages are client-rendered, so page text is useless — instead pull
// each org's live board once (cached per run) and look for the posting id.
async function ashbyVerdict(job: JobPosting, boardCache: Map<string, Set<string> | null>): Promise<Verdict> {
  const org = new URL(job.url).pathname.split("/").filter(Boolean)[0];
  const ashbyId = (job.raw as { ashbyId?: string }).ashbyId;
  if (!org || !ashbyId) return "unknown";
  if (!boardCache.has(org)) {
    const r = await fetchStatus(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(org)}`);
    if (r && r.status === 200) {
      try {
        const ids = new Set<string>(
          ((JSON.parse(r.body) as { jobs?: { id: string }[] }).jobs ?? []).map((j) => j.id),
        );
        boardCache.set(org, ids);
      } catch {
        boardCache.set(org, null);
      }
    } else {
      boardCache.set(org, null); // board unreachable — prove nothing this run
    }
  }
  const ids = boardCache.get(org);
  if (!ids) return "unknown";
  return ids.has(ashbyId) ? "open" : "closed";
}

async function checkJob(job: JobPosting, ashbyBoards: Map<string, Set<string> | null>): Promise<Verdict> {
  const raw = job.raw as Record<string, string | undefined>;
  switch (job.ats) {
    case "greenhouse": {
      if (!raw.boardToken || !raw.greenhouseId) break;
      return verdictFromApi(
        await fetchStatus(
          `https://boards-api.greenhouse.io/v1/boards/${raw.boardToken}/jobs/${raw.greenhouseId}`,
        ),
      );
    }
    case "lever": {
      const handle = /jobs\.lever\.co\/([^/]+)/.exec(job.url)?.[1];
      if (!handle || !raw.leverId) break;
      return verdictFromApi(
        await fetchStatus(`https://api.lever.co/v0/postings/${handle}/${raw.leverId}`),
      );
    }
    case "ashby":
      return ashbyVerdict(job, ashbyBoards);
    case "workday": {
      // Directly-discovered rows carry cxs coordinates in raw; aggregator-sourced
      // rows (builtin) only have the public URL, so derive them from it. The
      // public page 200s even for closed postings — only the cxs API is truthful.
      let { tenant, wd, site, externalPath } = raw;
      if (!tenant || !wd || !site || !externalPath) {
        const m = /^https:\/\/([^.]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/?#]+)(\/job\/[^?#]+)/.exec(
          job.applyUrl ?? job.url,
        );
        if (m) [, tenant, wd, site, externalPath] = m;
      }
      if (!tenant || !wd || !site || !externalPath) break;
      return verdictFromApi(
        await fetchStatus(
          `https://${tenant}.${wd}.myworkdayjobs.com/wday/cxs/${tenant}/${site}${externalPath}`,
        ),
      );
    }
    case "smartrecruiters": {
      if (!raw.companyIdentifier || !raw.smartrecruitersId) break;
      return verdictFromApi(
        await fetchStatus(
          `https://api.smartrecruiters.com/v1/companies/${raw.companyIdentifier}/postings/${raw.smartrecruitersId}`,
        ),
      );
    }
  }
  // Fallback for aggregator links and anything without API coordinates.
  const r = await fetchStatus(job.applyUrl ?? job.url);
  if (!r) return "unknown";
  if (r.status === 404 || r.status === 410) return "closed";
  if (r.status === 200 && CLOSED_SIGNATURES.test(r.body)) return "closed";
  return "unknown";
}

export async function scrubQueue(): Promise<{
  checked: number;
  closed: number;
  open: number;
  unknown: number;
}> {
  const queued = SCRUB_STATUSES.flatMap((s) => jobs.byStatus(s));
  const ashbyBoards = new Map<string, Set<string> | null>();
  let closed = 0;
  let open = 0;
  let unknown = 0;

  const concurrency = Math.max(1, Number(process.env.SCRUB_CONCURRENCY ?? 6));
  let next = 0;
  async function worker() {
    while (next < queued.length) {
      const job = queued[next++]!;
      const verdict = await checkJob(job, ashbyBoards);
      if (verdict === "closed") {
        closed++;
        jobs.setStatus(job.id, "skipped");
        events.log({ jobId: job.id, kind: "posting_closed", data: { was: job.status, ats: job.ats } });
      } else if (verdict === "open") {
        open++;
      } else {
        unknown++;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queued.length) }, worker));
  return { checked: queued.length, closed, open, unknown };
}
