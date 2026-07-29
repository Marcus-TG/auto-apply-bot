/**
 * Re-apply lane rules to jobs that were already scored, without re-running the
 * LLM. Run this after changing applyFloor / reviewFloor / lanes in
 * config/thresholds.json, otherwise the change only affects jobs discovered
 * from then on and everything already judged keeps its old verdict.
 *
 * Only moves jobs between the pre-submit verdict states (rejected <-> scored),
 * and only where the SCORER is the one that rejected them: a job whose stored
 * lane is anything but "reject" got to `rejected` some other way (you withdrew
 * it, or an approval timed out and failed closed), and re-laning must not
 * resurrect a decision you already made. Anything the apply layer has touched
 * (approved, submitting, submitted, needs_human, failed, skipped) is untouched.
 *
 * Demotions are opt-in AND self-limiting: --demote only reverses rescues this
 * script made earlier (it reads its own `relaned` events). It will never prune
 * a job that reached the queue some other way, because a below-floor job you
 * are deliberately keeping is not this script's business.
 *
 *   npx tsx scripts/relane.ts                    # dry run, prints what would change
 *   npx tsx scripts/relane.ts --apply            # write the rescues
 *   npx tsx scripts/relane.ts --apply --demote   # also drop now-below-floor jobs
 */
import { initSchema } from "../src/store/db.js";
import { jobs, scores, events } from "../src/store/repositories.js";
import { assignLane } from "../src/scoring/index.js";
import { laneFor } from "../src/scoring/lanes.js";

const APPLY = process.argv.includes("--apply");
const DEMOTE = process.argv.includes("--demote");

initSchema();

const candidates = [...jobs.byStatus("rejected"), ...jobs.byStatus("scored")];
const changes: { id: string; from: string; to: string; line: string }[] = [];

for (const job of candidates) {
  const score = scores.get(job.id);
  if (!score) continue;
  // Only the scorer's own rejections are up for reconsideration — see header.
  if (job.status === "rejected" && score.lane !== "reject") continue;

  const lane = assignLane(score, job);
  const want = lane === "reject" ? "rejected" : "scored";
  if (want === job.status) continue;
  if (want === "rejected") {
    if (!DEMOTE) continue;
    // Only undo our own rescues — see header.
    if (events.latestForJob(job.id, "relaned")?.data.to !== "scored") continue;
  }

  const laneId = laneFor(job)?.id ?? "-";
  changes.push({
    id: job.id,
    from: job.status,
    to: want,
    line: `[${score.overall.toFixed(0)}] ${laneId.padEnd(9)} ${job.company.slice(0, 22).padEnd(22)} ${job.title.slice(0, 44).padEnd(44)} ${(job.location ?? "").slice(0, 24)}`,
  });
}

const rescued = changes.filter((c) => c.to === "scored");
const demoted = changes.filter((c) => c.to === "rejected");

console.log(`${APPLY ? "APPLYING" : "DRY RUN"} — ${candidates.length} judged jobs examined`);
console.log(`  rejected -> scored: ${rescued.length}`);
console.log(`  scored -> rejected: ${demoted.length}${DEMOTE ? "" : " (demotions off; pass --demote to include them)"}`);
for (const c of rescued.slice(0, 20)) console.log(`   + ${c.line}`);
if (rescued.length > 20) console.log(`   … and ${rescued.length - 20} more`);
for (const c of demoted.slice(0, 20)) console.log(`   - ${c.line}`);

if (!APPLY) {
  console.log("\nNothing written. Re-run with --apply to commit these changes.");
} else {
  for (const c of changes) {
    jobs.setStatus(c.id, c.to as "scored" | "rejected");
    events.log({
      jobId: c.id,
      kind: "relaned",
      data: { from: c.from, to: c.to, lane: laneFor(jobs.get(c.id)!)?.id ?? null },
    });
  }
  console.log(`\nWrote ${changes.length} status changes.`);
  console.log("Rescued jobs have no hire-odds yet; the next refine pass picks them up.");
}
