/**
 * Agentic browser filler — the universal fallback for messy/unknown/layered career
 * sites (Phenom → iCIMS, Workday, bespoke portals) where a hardcoded filler doesn't
 * fit. Instead of per-ATS selectors, it drives the live Playwright page with a model
 * loop: observe the page → fill/click/upload → re-observe → repeat, through
 * multi-step flows, until it submits or hits a wall it must hand to the human.
 *
 * The loop asks for ONE structured action per step via callStructured(), so it runs
 * on whatever MODEL_GENERATION is set to — `claude-cli:` (subscription-billed CLI),
 * `ollama:`/`local:`, or a real API model id. Each step resends the transcript, with
 * stale page snapshots elided so only the latest observation carries full detail.
 *
 * Boundaries (by design, not weakness):
 *  - It never fabricates answers. Any required field not covered by the profile
 *    (open-ended essays, salary, sponsorship, EEO) → ask_human, not a guess.
 *  - Login/account-creation walls, email verification, and CAPTCHAs → ask_human
 *    (with the live-view URL) so a person finishes the identity-bound step.
 *  - DRY_RUN gates the one explicit submit tool — it fills everything but never
 *    actually sends.
 */
import { z } from "zod";
import type { Page } from "playwright";
import { config } from "../config/index.js";
import { callStructured } from "../llm/client.js";
import { events, submissions } from "../store/repositories.js";
import type { JobPosting, TailoredApplication, SubmitResult } from "../types/index.js";
import type { ApplicantFields } from "./field-map.js";

interface FieldInfo {
  idx: number;
  tag: string;
  type: string;
  label: string;
  name?: string;
  required: boolean;
  value: string;
  options?: string[];
}
interface Observation {
  url: string;
  title: string;
  captcha: boolean;
  loginWall: boolean;
  fields: FieldInfo[];
}

/** Snapshot the page: tag every visible interactive element with data-agent-idx and
 *  return a compact, indexed inventory the model can act on. DOM access goes through
 *  globalThis casts so we don't need the TS "DOM" lib in this Node project. */
async function observe(page: Page): Promise<Observation> {
  return (await page.evaluate(() => {
    const g = globalThis as any;
    const doc = g.document;
    const sel = "input,textarea,select,button,a[role=button],[role=button]";
    const els: any[] = Array.from(doc.querySelectorAll(sel));
    const fields: any[] = [];
    let i = 0;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      const cs = g.getComputedStyle(el);
      if (r.width <= 0 || r.height <= 0 || cs.visibility === "hidden" || cs.display === "none") continue;
      el.setAttribute("data-agent-idx", String(i));
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute("type") || "").toLowerCase();
      let label = "";
      const id = el.getAttribute("id");
      if (id) {
        const l = doc.querySelector(`label[for="${id}"]`);
        if (l) label = l.textContent || "";
      }
      if (!label)
        label =
          el.getAttribute("aria-label") ||
          el.getAttribute("placeholder") ||
          el.getAttribute("name") ||
          (tag === "button" || tag === "a" ? el.textContent || "" : "") ||
          "";
      label = label.trim().replace(/\s+/g, " ").slice(0, 90);
      const required = el.hasAttribute("required") || el.getAttribute("aria-required") === "true";
      let value = el.value || "";
      if (type === "password") value = value ? "***" : "";
      let options: string[] | undefined;
      if (tag === "select")
        options = Array.from(el.querySelectorAll("option"))
          .map((o: any) => (o.textContent || "").trim())
          .slice(0, 25);
      fields.push({ idx: i, tag, type, label, name: el.getAttribute("name") || undefined, required, value: String(value).slice(0, 40), options });
      i++;
      if (i >= 60) break;
    }
    const text = (doc.body?.innerText || "").toLowerCase();
    const captcha =
      /recaptcha|hcaptcha|verify you are human|are you a human/.test(text) ||
      Array.from(doc.querySelectorAll("iframe")).some((f: any) => /captcha/i.test(f.src || ""));
    const loginWall = !!doc.querySelector("input[type=password]") && /(sign in|log in|create account|register)/i.test(text);
    return { url: g.location.href, title: doc.title, captcha, loginWall, fields };
  })) as Observation;
}

async function fillField(page: Page, idx: number, value: string): Promise<void> {
  const loc = page.locator(`[data-agent-idx="${idx}"]`).first();
  const tag = await loc.evaluate((el: any) => el.tagName.toLowerCase());
  const type = ((await loc.getAttribute("type")) || "").toLowerCase();
  if (tag === "select") {
    await loc.selectOption({ label: value }).catch(() => loc.selectOption(value));
    return;
  }
  if (type === "checkbox" || type === "radio") {
    if (/^(true|yes|on|1|check)/i.test(value)) await loc.check();
    else await loc.uncheck().catch(() => {});
    return;
  }
  if (type === "file") throw new Error("use upload_resume for file inputs");
  await loc.fill(value);
}

async function readConfirmation(page: Page): Promise<string | null> {
  const body = (await page.content()).toLowerCase();
  return /thank you|application (received|submitted|complete)|we('|’)ve received|successfully applied/.test(body)
    ? page.url()
    : null;
}

const DecisionSchema = z.object({
  tool: z.enum(["observe", "fill", "click", "upload_resume", "submit_application", "ask_human"]),
  index: z.number().int().optional(),
  value: z.string().optional(),
  reason: z.string().optional(),
});
type Decision = z.infer<typeof DecisionSchema>;

const SYSTEM = `You complete a job application by operating a real browser, one action per turn.
You START already on the application page.

Actions (return exactly one per turn):
- observe — snapshot the current page and list its interactive fields/buttons by index.
  Do this first, and again after any click/navigation that changes the page.
- fill — type \`value\` into the text/checkbox/radio/select field at \`index\`.
- click — click the button/link at \`index\` (Next/Continue/expanders — NOT the final submit).
- upload_resume — upload the tailored resume PDF into the file input at \`index\`.
- submit_application — perform the FINAL submit via the button at \`index\`. Only when the
  whole form is complete.
- ask_human — stop and hand off, with \`reason\`.

Hard rules:
- Use ONLY the provided applicant profile. NEVER invent answers. For any required field
  not covered by the profile — open-ended essays ("why do you want to work here"), salary
  expectations, sponsorship/visa, or demographic/EEO questions you weren't given — call
  ask_human instead of guessing.
- If you hit a login/account-creation wall, an email-verification step, or a CAPTCHA,
  call ask_human with a clear reason. Do not try to solve CAPTCHAs.
- Upload the tailored resume to file inputs via upload_resume.
- To submit, use submit_application (never a plain click on the final submit button).
- Be efficient: skip fields already correct; don't re-observe needlessly.`;

interface TranscriptEntry {
  action: string;
  result: string;
  /** Full page snapshots are only worth tokens while current; older ones are elided. */
  isSnapshot: boolean;
}

function renderTranscript(transcript: TranscriptEntry[]): string {
  if (transcript.length === 0) return "No actions taken yet. Start with observe.";
  const lastSnapshot = transcript.reduce((acc, t, i) => (t.isSnapshot ? i : acc), -1);
  return transcript
    .map((t, i) => {
      const result =
        t.isSnapshot && i !== lastSnapshot
          ? "[stale page snapshot omitted — observe again if you need current state]"
          : t.result;
      return `${i + 1}. ${t.action} → ${result}`;
    })
    .join("\n");
}

export async function runAgenticApplication(
  page: Page,
  job: JobPosting,
  app: TailoredApplication,
  fields: ApplicantFields,
  liveViewUrl: string | null,
): Promise<SubmitResult> {
  const profileBlock = JSON.stringify(
    {
      name: fields.fullName,
      firstName: fields.firstName,
      lastName: fields.lastName,
      email: fields.email,
      phone: fields.phone,
      location: fields.location,
      linkedin: fields.linkedin ?? null,
      portfolio: fields.portfolio ?? null,
      cannedAnswers: fields.answers,
      questionsIDoNotHaveAnAnswerFor: fields.unknown,
    },
    null,
    2,
  );

  const task = `Apply to: ${job.title} at ${job.company}
The tailored resume PDF is already on disk and will be attached when you use upload_resume.`;

  const transcript: TranscriptEntry[] = [];
  let terminal: SubmitResult | null = null;
  let decisionFailures = 0;

  for (let step = 0; step < config.env.agenticMaxSteps && !terminal; step++) {
    let decision: Decision;
    try {
      decision = await callStructured({
        model: config.env.modelGeneration,
        system: SYSTEM,
        cachedContext: [
          { label: "Applicant profile (the only facts you may use)", text: profileBlock },
        ],
        userPrompt: `${task}\n\nActions so far:\n${renderTranscript(transcript)}\n\nWhat is your single next action?`,
        tool: {
          name: "next_action",
          description: "The single next browser action to take.",
          schema: DecisionSchema,
        },
        maxTokens: 1000,
      });
      decisionFailures = 0;
    } catch (err) {
      if (++decisionFailures >= 2) {
        terminal = { status: "needs_human", reason: `agent decision failed: ${String(err).slice(0, 300)}`, liveViewUrl };
        break;
      }
      continue;
    }

    const idx = decision.index;
    const action =
      decision.tool +
      (idx !== undefined ? `(index=${idx}${decision.value !== undefined ? `, value=${JSON.stringify(decision.value)}` : ""})` : decision.reason ? `(${decision.reason})` : "");
    let result = "ok";
    let isSnapshot = false;
    try {
      switch (decision.tool) {
        case "observe":
          result = JSON.stringify(await observe(page));
          isSnapshot = true;
          break;
        case "fill":
          if (idx === undefined || decision.value === undefined) throw new Error("fill needs index and value");
          await fillField(page, idx, decision.value);
          result = `filled field ${idx}`;
          break;
        case "click":
          if (idx === undefined) throw new Error("click needs index");
          await page.locator(`[data-agent-idx="${idx}"]`).first().click();
          await page.waitForLoadState("domcontentloaded").catch(() => {});
          result = `clicked ${idx}`;
          break;
        case "upload_resume":
          if (idx === undefined) throw new Error("upload_resume needs index");
          await page.locator(`[data-agent-idx="${idx}"]`).first().setInputFiles(app.resumePath);
          result = "resume uploaded";
          break;
        case "ask_human":
          events.log({ jobId: job.id, kind: "agent_needs_human", data: { reason: String(decision.reason ?? "unspecified") } });
          terminal = { status: "needs_human", reason: String(decision.reason ?? "unspecified"), liveViewUrl };
          result = "handed off to human";
          break;
        case "submit_application":
          if (config.env.dryRun) {
            await page.screenshot({ path: app.resumePath.replace(/resume\.pdf$/, "presubmit.png") }).catch(() => {});
            events.log({ jobId: job.id, kind: "agent_dry_run_submit", data: {} });
            terminal = { status: "submitted", confirmation: "DRY_RUN (not actually submitted)" };
            result = "DRY_RUN — submit simulated, not sent";
            break;
          }
          if (idx === undefined) throw new Error("submit_application needs index");
          await page.locator(`[data-agent-idx="${idx}"]`).first().click();
          await page.waitForLoadState("networkidle").catch(() => {});
          {
            const conf = await readConfirmation(page);
            if (conf) {
              submissions.record(job.id, conf);
              events.log({ jobId: job.id, kind: "agent_submitted", data: { confirmation: conf } });
              terminal = { status: "submitted", confirmation: conf };
              result = "submitted";
            } else {
              terminal = { status: "needs_human", reason: "clicked submit but no confirmation page detected", liveViewUrl };
              result = "no confirmation detected — handed off";
            }
          }
          break;
      }
    } catch (err) {
      result = `error: ${String(err)}`;
    }
    transcript.push({ action, result, isSnapshot });
  }

  if (!terminal) {
    events.log({ jobId: job.id, kind: "agent_step_budget_exhausted", data: {} });
    terminal = { status: "needs_human", reason: "agent step budget exhausted", liveViewUrl };
  }
  return terminal;
}
