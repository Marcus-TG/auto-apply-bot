/**
 * Stage 2 of scoring: LLM rubric scoring via Claude, forced into JSON by tool-use.
 *
 * Cost control:
 *  - The candidate profile + resume-variant summaries are passed as CACHED context,
 *    identical across every job, so prompt caching amortizes them.
 *  - `overall` is computed by US from the returned per-dimension scores using the
 *    weights in config — we don't trust the model to do the weighted arithmetic.
 */
import { z } from "zod";
import { config } from "../config/index.js";
import { callStructured } from "../llm/client.js";
import { FitScore } from "../types/index.js";
import type { JobPosting } from "../types/index.js";
import type { CandidateProfile } from "./prefilter.js";

/** What we ask the model for. We compute `overall` ourselves from `dimensions`. */
const ScorerOutput = z.object({
  dimensions: z.array(
    z.object({
      name: z.string(),
      score: z.number().min(0).max(100),
      rationale: z.string(),
    }),
  ),
  confidence: z.number().min(0).max(1),
  recommendedVariant: z.string(),
  summary: z.string(),
  matchedKeywords: z.array(z.string()),
  gapKeywords: z.array(z.string()),
});

export interface VariantSummary {
  id: string;
  label: string;
  targetRoles: string[];
  summary: string;
  skills: string[];
}

const SYSTEM = `You are a rigorous hiring-fit evaluator for a specific candidate.
Score each dimension on a 0-100 scale (100 = perfect fit).
Score honestly — a low score is more useful than an inflated one. Never claim the
candidate has experience not supported by their profile. Put JD keywords the
candidate genuinely supports in matchedKeywords, and important JD keywords they
lack in gapKeywords. Choose recommendedVariant from the provided variant ids.`;

function weightedOverall(dims: { name: string; score: number }[]): number {
  const weights = config.thresholds.weights;
  let sum = 0;
  let wsum = 0;
  for (const d of dims) {
    const w = weights[d.name] ?? 0;
    sum += d.score * w;
    wsum += w;
  }
  // If dimension names don't match configured weights, fall back to a plain mean.
  if (wsum === 0) return Math.round(dims.reduce((a, d) => a + d.score, 0) / (dims.length || 1));
  return Math.round(sum / wsum);
}

export async function scoreWithLlm(
  job: JobPosting,
  profile: CandidateProfile,
  variants: VariantSummary[],
  model: string = config.env.modelPrefilter,
): Promise<FitScore> {
  const dimensionNames = Object.keys(config.thresholds.weights);

  const out = await callStructured({
    model,
    system: SYSTEM,
    cachedContext: [
      { label: "Candidate profile", text: JSON.stringify(profile, null, 2) },
      { label: "Resume variants (choose the best fit)", text: JSON.stringify(variants, null, 2) },
      {
        label: "Rubric dimensions to score (use exactly these names)",
        text: dimensionNames.join(", "),
      },
    ],
    userPrompt: `Score this posting for the candidate.

Company: ${job.company}
Title: ${job.title}
Location: ${job.location ?? "n/a"} (${job.remote})
Description:
${job.description.slice(0, 6000)}`,
    tool: {
      name: "record_fit_score",
      description: "Record the structured fit assessment for this job.",
      schema: ScorerOutput,
    },
    maxTokens: 1500,
  });

  return FitScore.parse({
    jobId: job.id,
    overall: weightedOverall(out.dimensions),
    confidence: out.confidence,
    dimensions: out.dimensions,
    recommendedVariant: out.recommendedVariant,
    summary: out.summary,
    matchedKeywords: out.matchedKeywords,
    gapKeywords: out.gapKeywords,
    model,
    scoredAt: new Date().toISOString(),
  });
}
