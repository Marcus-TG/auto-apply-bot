/**
 * Loads resume variants from config/resume-variants/*.json and provides variant
 * lookup + a lightweight summary form for the scorer.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ResumeVariant } from "./model.js";
import type { VariantSummary } from "../scoring/llm-scorer.js";

const DIR = resolve(process.cwd(), "config/resume-variants");

export function loadVariants(): ResumeVariant[] {
  // Skip example-*.json — those are templates shipped with the repo, not real variants.
  const files = readdirSync(DIR).filter((f) => f.endsWith(".json") && !f.startsWith("example"));
  return files.map((f) => ResumeVariant.parse(JSON.parse(readFileSync(resolve(DIR, f), "utf8"))));
}

export function variantSummaries(variants: ResumeVariant[]): VariantSummary[] {
  return variants.map((v) => ({
    id: v.id,
    label: v.label,
    targetRoles: v.targetRoles,
    summary: v.summary,
    skills: v.skills,
  }));
}

export function getVariant(variants: ResumeVariant[], id: string): ResumeVariant {
  return variants.find((v) => v.id === id) ?? variants[0]!;
}
