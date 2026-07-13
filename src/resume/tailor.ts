/**
 * Resume tailoring = SELECTION, not fabrication.
 *
 * The model is given the chosen variant's approved bullet pool and the JD, and it
 * returns, per experience, the IDS of the bullets to keep and their order, plus a
 * tailored summary line. We then look those ids up in the pool and emit their
 * EXACT approved text — the model never gets to write bullet content, so it can't
 * invent experience. The only free-text it produces is the summary line, which we
 * constrain to the candidate's real skills.
 */
import { z } from "zod";
import { config } from "../config/index.js";
import { callStructured } from "../llm/client.js";
import type { ResumeVariant, RenderedResume, Bullet } from "./model.js";
import type { JobPosting, FitScore } from "../types/index.js";

const TailorPlan = z.object({
  summary: z.string(),
  experiences: z.array(
    z.object({
      company: z.string(),
      /** Bullet ids to include, in final display order. Must come from the pool. */
      bulletIds: z.array(z.string()),
    }),
  ),
});

const SYSTEM = `You tailor a resume by SELECTING which pre-approved bullets to show
for a given job and in what order — you do NOT write new bullets. Pick the bullets
whose tags/impact best match the job. Return bullet IDs only. You may write a single
tailored summary line, but it must only reference skills already in the variant.
Never state or imply experience the candidate does not have.
Never use em dashes in the summary line; use commas, colons, or separate sentences.
Never describe the candidate as an "engineer" (a regulated title in their province);
use "specialist", "builder", "developer", or "administrator" instead.
The resume must fit ONE page: select at most 12 bullets total, weighted toward the
most relevant experiences (the renderer trims overflow from the tail, so order matters).`;

/** Em/en dashes read as machine-generated; normalize them out of free text. */
const scrubDashes = (s: string) => s.replace(/\s*—\s*/g, ", ").replace(/\s+–\s+/g, ", ");

/** "Engineer" is a regulated title in Canadian provinces (e.g. Ontario's
 *  Professional Engineers Act) — never let the summary self-apply it. */
const scrubEngineerTitle = (s: string) => s.replace(/\bengineers?\b/gi, "specialist");

export async function tailorResume(
  job: JobPosting,
  variant: ResumeVariant,
  score: FitScore,
  model: string = config.env.modelGeneration,
  /** Optional human direction ("prioritize monitoring bullets", "lead with X"). */
  directive?: string,
): Promise<RenderedResume> {
  // Freelance entries may have an empty display company; key on title instead so
  // the model's plan can still reference them.
  const keyOf = (e: { company: string; title: string }) => e.company || e.title;
  const poolByCompany = new Map<string, Bullet[]>();
  for (const exp of variant.experiences) poolByCompany.set(keyOf(exp), exp.bulletPool);

  const plan = await callStructured({
    model,
    system: SYSTEM,
    userPrompt: `Job: ${job.title} at ${job.company}
${directive ? `Candidate's direction (follow it within the rules): ${directive}\n` : ""}Matched keywords (safe to emphasise): ${score.matchedKeywords.join(", ")}
Do NOT imply these gaps: ${score.gapKeywords.join(", ")}

Variant "${variant.id}" summary: ${variant.summary}
Approved bullets per experience:
${variant.experiences
  .map(
    (e) =>
      `- ${keyOf(e)} (${e.title}):\n` +
      e.bulletPool.map((b) => `    [${b.id}] (tags: ${b.tags.join(", ")}) ${b.text}`).join("\n"),
  )
  .join("\n")}

Job description:
${job.description.slice(0, 5000)}`,
    tool: {
      name: "select_resume_content",
      description: "Choose which approved bullets to show and in what order.",
      schema: TailorPlan,
    },
    maxTokens: 1200,
  });

  // Resolve ids → exact approved text. Silently drop any id the model invented.
  const experiences = variant.experiences.map((exp) => {
    const chosen = plan.experiences.find((p) => p.company === keyOf(exp));
    const pool = poolByCompany.get(keyOf(exp)) ?? [];
    const byId = new Map(pool.map((b) => [b.id, b.text]));
    const bullets = (chosen?.bulletIds ?? [])
      .map((id) => byId.get(id))
      .filter((t): t is string => !!t);
    // Fallback: if the model returned nothing valid, keep the top-impact bullets.
    const finalBullets =
      bullets.length > 0
        ? bullets
        : [...pool].sort((a, b) => b.impact - a.impact).slice(0, 3).map((b) => b.text);
    return {
      company: exp.company,
      title: exp.title,
      location: exp.location,
      start: exp.start,
      end: exp.end,
      bullets: finalBullets,
    };
  });

  return {
    variantId: variant.id,
    summary: scrubEngineerTitle(scrubDashes(plan.summary || variant.summary)),
    skills: variant.skills,
    experiences,
    education: variant.education,
  };
}
