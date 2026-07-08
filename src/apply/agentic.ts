/**
 * Agentic browser filler — the universal fallback for messy/unknown/layered career
 * sites (Phenom → iCIMS, Workday, bespoke portals) where a hardcoded filler doesn't
 * fit. Instead of per-ATS selectors, it drives the live Playwright page with a Claude
 * tool loop: observe the page → fill/click/upload → re-observe → repeat, through
 * multi-step flows, until it submits or hits a wall it must hand to the human.
 *
 * Boundaries (by design, not weakness):
 *  - It never fabricates answers. Any required field not covered by the profile
 *    (open-ended essays, salary, sponsorship, EEO) → ask_human, not a guess.
 *  - Login/account-creation walls, email verification, and CAPTCHAs → ask_human
 *    (with the live-view URL) so a person finishes the identity-bound step.
 *  - DRY_RUN gates the one explicit submit tool — it fills everything but never
 *    actually sends.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";
import { config } from "../config/index.js";
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

const TOOLS: Anthropic.Tool[] = [
  { name: "observe", description: "Snapshot the current page and list its interactive fields/buttons by index. Call this first and after every navigation.", input_schema: { type: "object", properties: {} } },
  { name: "fill", description: "Type a value into a text/checkbox/radio/select field by its index.", input_schema: { type: "object", properties: { index: { type: "integer" }, value: { type: "string" } }, required: ["index", "value"] } },
  { name: "click", description: "Click a button or link by index (for Next/Continue/expanders — NOT the final submit).", input_schema: { type: "object", properties: { index: { type: "integer" } }, required: ["index"] } },
  { name: "upload_resume", description: "Upload the tailored resume PDF into a file input by index.", input_schema: { type: "object", properties: { index: { type: "integer" } }, required: ["index"] } },
  { name: "submit_application", description: "Perform the FINAL submit by clicking the submit button at the given index. Use only when the whole form is complete.", input_schema: { type: "object", properties: { index: { type: "integer" } }, required: ["index"] } },
  { name: "ask_human", description: "Stop and hand off to the human for anything requiring their identity or judgment: login/account creation, email verification, CAPTCHA, or a required question not answered by the profile.", input_schema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] } },
];

const SYSTEM = `You complete a job application by operating a real browser through tools.
You START already on the application page.

Loop: observe → fill/click/upload_resume → observe again → continue through multi-step
flows until submitted.

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

export async function runAgenticApplication(
  page: Page,
  job: JobPosting,
  app: TailoredApplication,
  fields: ApplicantFields,
  liveViewUrl: string | null,
): Promise<SubmitResult> {
  const anthropic = new Anthropic({ apiKey: config.env.anthropicApiKey });

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

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `Apply to: ${job.title} at ${job.company}
Applicant profile (the only facts you may use):
${profileBlock}

The tailored resume PDF is already on disk and will be attached when you call upload_resume.
Begin by calling observe.`,
    },
  ];

  let terminal: SubmitResult | null = null;

  for (let step = 0; step < config.env.agenticMaxSteps && !terminal; step++) {
    const resp = await anthropic.messages.create({
      model: config.env.modelGeneration,
      max_tokens: 1500,
      system: SYSTEM,
      tools: TOOLS,
      messages,
    });
    messages.push({ role: "assistant", content: resp.content });

    const toolUses = resp.content.filter((c): c is Anthropic.ToolUseBlock => c.type === "tool_use");
    if (toolUses.length === 0) {
      terminal = { status: "needs_human", reason: "agent stopped without taking an action", liveViewUrl };
      break;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const input = (tu.input ?? {}) as Record<string, unknown>;
      let content = "ok";
      try {
        switch (tu.name) {
          case "observe":
            content = JSON.stringify(await observe(page));
            break;
          case "fill":
            await fillField(page, Number(input.index), String(input.value));
            content = `filled field ${input.index}`;
            break;
          case "click":
            await page.locator(`[data-agent-idx="${Number(input.index)}"]`).first().click();
            await page.waitForLoadState("domcontentloaded").catch(() => {});
            content = `clicked ${input.index}`;
            break;
          case "upload_resume":
            await page.locator(`[data-agent-idx="${Number(input.index)}"]`).first().setInputFiles(app.resumePath);
            content = "resume uploaded";
            break;
          case "ask_human":
            events.log({ jobId: job.id, kind: "agent_needs_human", data: { reason: String(input.reason) } });
            terminal = { status: "needs_human", reason: String(input.reason), liveViewUrl };
            content = "handed off to human";
            break;
          case "submit_application":
            if (config.env.dryRun) {
              await page.screenshot({ path: app.resumePath.replace(/resume\.pdf$/, "presubmit.png") }).catch(() => {});
              events.log({ jobId: job.id, kind: "agent_dry_run_submit", data: {} });
              terminal = { status: "submitted", confirmation: "DRY_RUN (not actually submitted)" };
              content = "DRY_RUN — submit simulated, not sent";
              break;
            }
            await page.locator(`[data-agent-idx="${Number(input.index)}"]`).first().click();
            await page.waitForLoadState("networkidle").catch(() => {});
            {
              const conf = await readConfirmation(page);
              if (conf) {
                submissions.record(job.id, conf);
                events.log({ jobId: job.id, kind: "agent_submitted", data: { confirmation: conf } });
                terminal = { status: "submitted", confirmation: conf };
                content = "submitted";
              } else {
                terminal = { status: "needs_human", reason: "clicked submit but no confirmation page detected", liveViewUrl };
                content = "no confirmation detected — handed off";
              }
            }
            break;
          default:
            content = `unknown tool ${tu.name}`;
        }
      } catch (err) {
        content = `error: ${String(err)}`;
      }
      results.push({ type: "tool_result", tool_use_id: tu.id, content });
    }
    messages.push({ role: "user", content: results });
  }

  if (!terminal) {
    events.log({ jobId: job.id, kind: "agent_step_budget_exhausted", data: {} });
    terminal = { status: "needs_human", reason: "agent step budget exhausted", liveViewUrl };
  }
  return terminal;
}
