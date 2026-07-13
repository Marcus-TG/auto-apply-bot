/**
 * Central config loader. Reads .env + the JSON files under /config and exposes
 * one typed, validated `config` object. Fail fast: a bad config should throw at
 * startup, not halfway through a submission.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const ROOT = resolve(process.cwd());

function readJson(relPath: string): unknown {
  return JSON.parse(readFileSync(resolve(ROOT, relPath), "utf8"));
}

/** Read the first JSON file that exists. Lets user-local config (gitignored)
 *  shadow the committed example, same pattern as profile.json. */
function readJsonFirst(relPaths: string[]): unknown {
  for (const rel of relPaths) {
    try {
      return readJson(rel);
    } catch {
      /* try next */
    }
  }
  throw new Error(`None of these config files could be read: ${relPaths.join(", ")}`);
}

const bool = (v: string | undefined, dflt: boolean) =>
  v === undefined ? dflt : v.toLowerCase() === "true";

// ---- config/thresholds.json ----
const ThresholdsSchema = z.object({
  /** Below this overall score → reject lane. */
  applyFloor: z.number().min(0).max(100),
  /** At/above this overall score → always human review (the "don't fly blind" band). */
  reviewFloor: z.number().min(0).max(100),
  /** Jobs between applyFloor and reviewFloor take the auto lane IF autoApplyEnabled. */
  autoApplyEnabled: z.boolean(),
  /** If model confidence is below this, force review regardless of score. */
  minConfidenceForAuto: z.number().min(0).max(1),
  /** Rubric dimension weights; must sum to ~1. */
  weights: z.record(z.number()),
  /** Hours to wait for a human decision before the run times out to "hold". */
  approvalTimeoutHours: z.number().positive(),
});

// ---- config/sources.json ----
const SourceEntry = z.object({
  kind: z.string(),
  enabled: z.boolean(),
  /** Company slugs / board tokens to poll for ATS APIs. */
  companies: z.array(z.string()).default([]),
  /** Free-text search queries for aggregators. */
  queries: z.array(z.string()).default([]),
  notes: z.string().optional(),
});
const SourcesSchema = z.object({ sources: z.array(SourceEntry) });

const env = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  modelPrefilter: process.env.MODEL_PREFILTER ?? "claude-haiku-4-5-20251001",
  modelGeneration: process.env.MODEL_GENERATION ?? "claude-sonnet-5",
  // Local / OpenAI-compatible runtime (Ollama :11434, LM Studio :1234, vLLM, …).
  // Any model id prefixed `local:` or `ollama:` routes here instead of Anthropic.
  localLlmBaseUrl: process.env.LOCAL_LLM_BASE_URL ?? "http://localhost:11434/v1",
  localLlmApiKey: process.env.LOCAL_LLM_API_KEY ?? "ollama",
  databasePath: process.env.DATABASE_PATH ?? "./data/app.sqlite",
  artifactsDir: process.env.ARTIFACTS_DIR ?? "./artifacts",
  port: Number(process.env.PORT ?? 8787),
  // Where approve/reject links point. Empty → http://localhost:PORT (links
  // then only work on the server itself).
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "",
  webhookSecret: process.env.WEBHOOK_SECRET ?? "change-me",
  n8nApprovalWebhook: process.env.N8N_APPROVAL_WEBHOOK ?? "",
  browserProvider: (process.env.BROWSER_PROVIDER ?? "local") as
    | "kernel-cloud"
    | "kernel-selfhost"
    | "local",
  kernelApiKey: process.env.KERNEL_API_KEY ?? "",
  kernelCdpUrl: process.env.KERNEL_CDP_URL ?? "http://localhost:9222",
  kernelLiveViewUrl: process.env.KERNEL_LIVE_VIEW_URL ?? "",
  // Kernel cloud: stealth bundles their anti-bot + CAPTCHA handling. Our own
  // captcha detection still backstops it and hands off to the live view.
  kernelStealth: bool(process.env.KERNEL_STEALTH, true),
  // Optional saved profile id (persistent login, e.g. for LinkedIn/Indeed sessions).
  kernelProfileId: process.env.KERNEL_PROFILE_ID ?? "",
  // Inactivity timeout for the remote session; live-view + CDP connections count as
  // activity. Raise toward 259200 (72h) if you want long human-in-the-loop pauses.
  kernelTimeoutSeconds: Number(process.env.KERNEL_TIMEOUT_SECONDS ?? 300),
  dryRun: bool(process.env.DRY_RUN, true),
  // Adzuna official API — free key from https://developer.adzuna.com.
  // The adzuna source stays blocked until both are set.
  adzunaAppId: process.env.ADZUNA_APP_ID ?? "",
  adzunaAppKey: process.env.ADZUNA_APP_KEY ?? "",
  adzunaCountry: process.env.ADZUNA_COUNTRY ?? "ca",
  enableLinkedin: bool(process.env.ENABLE_LINKEDIN, false),
  enableIndeed: bool(process.env.ENABLE_INDEED, false),
  maxSubmissionsPerDay: Number(process.env.MAX_SUBMISSIONS_PER_DAY ?? 15),
  // When the ATS is unknown/custom (Phenom, iCIMS, bespoke portals), drive the
  // application with an AI browser-agent loop instead of a hardcoded filler.
  agenticFallback: bool(process.env.AGENTIC_FALLBACK, true),
  // Hard cap on agent tool-steps per application (bounds cost + runaway loops).
  agenticMaxSteps: Number(process.env.AGENTIC_MAX_STEPS ?? 25),
};

export const config = {
  env,
  thresholds: ThresholdsSchema.parse(readJson("config/thresholds.json")),
  sources: SourcesSchema.parse(
    readJsonFirst(["config/sources.json", "config/sources.example.json"]),
  ).sources,
};

export type AppConfig = typeof config;

/** Guardrail: refuse to even construct ToS-restricted adapters unless the env flag is on. */
export function sourceAllowed(kind: string): boolean {
  if (kind === "linkedin") return config.env.enableLinkedin;
  if (kind === "indeed") return config.env.enableIndeed;
  if (kind === "adzuna") return Boolean(config.env.adzunaAppId && config.env.adzunaAppKey);
  return true;
}
