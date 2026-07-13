/**
 * Cover letter generation. Grounded in three things so it reads as human and
 * specific, not templated:
 *   1. The actual JD (specific hooks — the team, product, a stated challenge).
 *   2. The tailored resume content (so claims match the resume, no new facts).
 *   3. The user's own voice sample (so it sounds like them).
 *
 * Two passes: draft, then a self-critique rewrite that strips buzzwords/filler.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config/index.js";
import { callText } from "../llm/client.js";
import type { RenderedResume } from "../resume/model.js";
import type { JobPosting, FitScore } from "../types/index.js";

interface Identity {
  fullName: string;
  email: string;
}

const SYSTEM = `You write cover letters that sound like a real, specific person.
Rules:
- Ground every claim in the provided resume content; introduce no new facts.
- Never state durations, dates, or metrics (e.g. "six years at X") unless they
  appear verbatim in the provided content.
- Reference something concrete about THIS role/company from the job description.
- Match the candidate's voice sample. No buzzwords, no "I am passionate about", no
  generic filler. Prefer concrete outcomes over adjectives.
- Never use em dashes or en dashes; use commas, colons, or separate sentences.
- 3 short paragraphs, ~200-250 words. Open on a specific hook, not "Dear..." or
  "I am writing to...". Body only: no greeting line and no sign-off; the letter
  frame is added programmatically afterward.`;

/** Em/en dashes read as machine-generated; normalize them out of free text. */
const scrubDashes = (s: string) => s.replace(/\s*—\s*/g, ", ").replace(/\s+–\s+/g, ", ");

/** Strip wrapper artifacts models sometimes emit around the letter itself:
 *  code fences, leading/trailing "---" rules, markdown title lines, and short
 *  meta lead-ins like "Here's the revised letter:". */
function cleanLetter(s: string): string {
  let text = s.replace(/```[a-z]*\n?/gi, "").trim();
  const lines = text.split("\n");
  while (lines.length) {
    const first = lines[0]!.trim();
    const isMeta =
      first === "" ||
      first === "---" ||
      /^#{1,4}\s/.test(first) ||
      /^\*\*[^*]+\*\*$/.test(first) ||
      (first.length < 120 && /letter/i.test(first) && /[:.]$/.test(first));
    if (!isMeta) break;
    lines.shift();
  }
  while (lines.length && ["", "---"].includes(lines[lines.length - 1]!.trim())) lines.pop();
  return lines.join("\n").trim();
}

/** The model writes body-only prose; the letter frame (greeting + sign-off) is
 *  added here so it can never come out malformed. Idempotent: skips either part
 *  if the text already has it, so re-framing an existing letter is safe. */
export function frameLetter(body: string, company: string, fullName: string): string {
  let text = body.trim();
  if (!/^(hi|hello|dear)\b/i.test(text)) text = `Hi ${company} team,\n\n${text}`;
  const firstName = fullName.split(" ")[0]!;
  if (!text.endsWith(fullName) && !text.endsWith(firstName)) {
    text = `${text}\n\nBest,\n${fullName}`;
  }
  return text;
}

export async function generateCoverLetter(
  job: JobPosting,
  resume: RenderedResume,
  score: FitScore,
  identity: Identity,
  voiceSample: string,
  model: string = config.env.modelGeneration,
): Promise<{ text: string; path: string }> {
  const context = `Voice sample (mimic this tone):
"""${voiceSample}"""

Candidate: ${identity.fullName}
Resume summary: ${resume.summary}
Key resume points:
${resume.experiences.flatMap((e) => e.bullets.map((b) => `- ${b} (${e.company})`)).join("\n")}
Genuine strengths for this role: ${score.matchedKeywords.join(", ")}`;

  const draft = await callText({
    model,
    system: SYSTEM,
    cachedContext: [{ label: "Candidate context", text: context }],
    userPrompt: `Write a cover letter for:
${job.title} at ${job.company}

Job description (pull a specific hook from here):
${job.description.slice(0, 4000)}`,
    maxTokens: 700,
  });

  // Self-critique pass: tighten and de-buzzword.
  const final = cleanLetter(scrubDashes(
    await callText({
      model,
      system:
        "Revise the cover letter to remove any buzzwords, clichés, or generic claims, " +
        "keep only concrete points grounded in the resume, and preserve the candidate's voice. " +
        "Never use em dashes or en dashes; use commas, colons, or separate sentences. " +
        "Return only the revised letter.",
      userPrompt: draft,
      maxTokens: 700,
    }),
  ));

  // A letter that still looks like model scaffolding must fail loudly, not ship.
  if (final.length < 200 || final.includes("```") || /\bLet me\b|\bI need to find\b/.test(final)) {
    throw new Error(`cover letter failed sanity check: ${final.slice(0, 120)}`);
  }

  const framed = frameLetter(final, job.company, identity.fullName);
  const dir = resolve(process.cwd(), config.env.artifactsDir, job.id);
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, "cover-letter.txt");
  writeFileSync(path, framed);
  return { text: framed, path };
}

/** Revise an existing letter per a human instruction, keeping every grounding
 *  rule (no new facts, no em dashes, candidate's voice). Writes the file. */
export async function reviseCoverLetter(
  job: JobPosting,
  resume: RenderedResume,
  currentText: string,
  instruction: string,
  voiceSample: string,
  fullName: string,
  model: string = config.env.modelGeneration,
): Promise<{ text: string; path: string }> {
  const revised = cleanLetter(scrubDashes(
    await callText({
      model,
      system:
        SYSTEM +
        "\nYou are REVISING an existing letter per the candidate's instruction. " +
        "Apply the instruction faithfully, change nothing else that works, and return only the revised letter.",
      cachedContext: [
        {
          label: "Grounding: the resume content this letter may draw on",
          text: `Summary: ${resume.summary}\nBullets:\n${resume.experiences
            .flatMap((e) => e.bullets.map((b) => `- ${b} (${e.company})`))
            .join("\n")}\nVoice sample: """${voiceSample}"""`,
        },
      ],
      userPrompt: `Candidate's instruction: ${instruction}

Job: ${job.title} at ${job.company}

Current letter:
${currentText}`,
      maxTokens: 700,
    }),
  ));
  if (revised.length < 200 || revised.includes("```")) {
    throw new Error(`revision failed sanity check: ${revised.slice(0, 120)}`);
  }
  const framed = frameLetter(revised, job.company, fullName);
  const path = resolve(process.cwd(), config.env.artifactsDir, job.id, "cover-letter.txt");
  writeFileSync(path, framed);
  return { text: framed, path };
}
