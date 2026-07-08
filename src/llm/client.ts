/**
 * Thin Anthropic wrapper.
 *
 * Two things matter here:
 *  1. Prompt caching — the candidate profile + rubric are identical on every job,
 *     so we mark them `cache_control` and only pay full price once per ~5 min window.
 *  2. Structured output via tool-use — we force the model to return JSON matching a
 *     Zod schema by defining a single tool and reading tool_use input, then validating.
 *
 * If ANTHROPIC_API_KEY is unset, calls throw a clear error — the pipeline still
 * runs end-to-end in DRY_RUN using stubbed scores if you wire the stub in scoring/.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config } from "../config/index.js";

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!config.env.anthropicApiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Set it in .env, or run scoring in stub mode.",
    );
  }
  _client ??= new Anthropic({ apiKey: config.env.anthropicApiKey });
  return _client;
}

/** A block of context that should be prompt-cached (reused across many jobs). */
export interface CachedBlock {
  label: string;
  text: string;
}

export interface StructuredCallOptions<T> {
  model: string;
  /** System instruction. Kept short; big reusable context goes in `cachedContext`. */
  system: string;
  /** Large, stable context (profile, rubric). Marked for prompt caching. */
  cachedContext?: CachedBlock[];
  /** The per-job prompt (the JD, the specific ask). */
  userPrompt: string;
  /** Name + description + Zod schema of the JSON we want back. */
  tool: { name: string; description: string; schema: z.ZodType<T> };
  maxTokens?: number;
}

/**
 * Make a call that MUST return JSON matching `tool.schema`. Uses tool-use so the
 * model can't wander off-format, then validates with Zod (throws on mismatch).
 */
export async function callStructured<T>(opts: StructuredCallOptions<T>): Promise<T> {
  if (isLocalModel(opts.model)) return callStructuredLocal(opts);
  if (isClaudeCliModel(opts.model)) return callStructuredCli(opts);
  const cachedBlocks = (opts.cachedContext ?? []).map((b, i, arr) => ({
    type: "text" as const,
    text: `## ${b.label}\n${b.text}`,
    // Cache the final stable block; caching the last block caches everything before it.
    ...(i === arr.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
  }));

  const resp = await client().messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 2048,
    system: [{ type: "text", text: opts.system }, ...cachedBlocks],
    tools: [
      {
        name: opts.tool.name,
        description: opts.tool.description,
        input_schema: zodToJsonSchema(opts.tool.schema) as Anthropic.Tool.InputSchema,
      },
    ],
    tool_choice: { type: "tool", name: opts.tool.name },
    messages: [{ role: "user", content: opts.userPrompt }],
  });

  const toolUse = resp.content.find((c) => c.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error(`Model did not return a ${opts.tool.name} tool call.`);
  }
  return opts.tool.schema.parse(toolUse.input);
}

/** Plain text generation (cover letters). Also supports cached context. */
export async function callText(opts: {
  model: string;
  system: string;
  cachedContext?: CachedBlock[];
  userPrompt: string;
  maxTokens?: number;
}): Promise<string> {
  if (isLocalModel(opts.model)) return callTextLocal(opts);
  if (isClaudeCliModel(opts.model)) return callTextCli(opts);
  const cachedBlocks = (opts.cachedContext ?? []).map((b, i, arr) => ({
    type: "text" as const,
    text: `## ${b.label}\n${b.text}`,
    ...(i === arr.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
  }));
  const resp = await client().messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 1500,
    system: [{ type: "text", text: opts.system }, ...cachedBlocks],
    messages: [{ role: "user", content: opts.userPrompt }],
  });
  return resp.content
    .filter((c) => c.type === "text")
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("\n")
    .trim();
}

/**
 * Minimal Zod → JSON Schema for the shapes we use (objects, arrays, primitives,
 * enums, nullable, optional). Kept in-repo to avoid a dependency; extend as the
 * rubric grows. For anything exotic, prefer adding a case here over `z.any()`.
 */
export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const def = (schema as unknown as { _def: { typeName: string } })._def;
  const t = def.typeName;
  const anyDef = def as Record<string, unknown>;

  switch (t) {
    case "ZodObject": {
      const shape = (anyDef.shape as () => Record<string, z.ZodType>)();
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, child] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(child);
        if (!isOptional(child)) required.push(key);
      }
      return { type: "object", properties, required };
    }
    case "ZodArray":
      return { type: "array", items: zodToJsonSchema(anyDef.type as z.ZodType) };
    case "ZodString":
      return { type: "string" };
    case "ZodNumber": {
      const out: Record<string, unknown> = { type: "number" };
      const checks = (anyDef.checks ?? []) as { kind: string; value?: number }[];
      for (const c of checks) {
        if (c.kind === "min") out.minimum = c.value;
        if (c.kind === "max") out.maximum = c.value;
        if (c.kind === "int") out.type = "integer";
      }
      return out;
    }
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodEnum":
      return { type: "string", enum: anyDef.values as string[] };
    case "ZodNullable":
      return zodToJsonSchema(anyDef.innerType as z.ZodType);
    case "ZodOptional":
      return zodToJsonSchema(anyDef.innerType as z.ZodType);
    case "ZodDefault":
      return zodToJsonSchema(anyDef.innerType as z.ZodType);
    case "ZodRecord":
      return { type: "object", additionalProperties: true };
    default:
      return {};
  }
}

function isOptional(schema: z.ZodType): boolean {
  const t = (schema as unknown as { _def: { typeName: string } })._def.typeName;
  return t === "ZodOptional" || t === "ZodDefault";
}

// ---- Local / OpenAI-compatible provider (Ollama, LM Studio, vLLM, llama.cpp) ----
//
// A model id prefixed `local:` or `ollama:` routes here instead of Anthropic — it hits
// LOCAL_LLM_BASE_URL/chat/completions (OpenAI-compatible). Free at the margin, so this
// is where the high-volume fit-scoring belongs; keep the agent + cover letters on a
// strong hosted model. Prompt caching doesn't apply locally, so cached context is just
// folded into the system prompt. Structured output uses JSON mode + the same
// zod→JSON-schema, then Zod-validates (with slop-tolerant extraction) exactly like the
// Anthropic path.

export function isLocalModel(model: string): boolean {
  return model.startsWith("local:") || model.startsWith("ollama:");
}

function stripLocalPrefix(model: string): string {
  return model.replace(/^(local|ollama):/, "");
}

/** Pull the JSON object out of a model reply that may include fences or stray prose. */
function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return start >= 0 && end > start ? body.slice(start, end + 1) : body;
}

async function localChat(
  model: string,
  system: string,
  user: string,
  maxTokens: number,
  jsonMode: boolean,
): Promise<string> {
  const res = await fetch(`${config.env.localLlmBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.env.localLlmApiKey}`,
    },
    body: JSON.stringify({
      model: stripLocalPrefix(model),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0,
      max_tokens: maxTokens,
      stream: false,
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`Local LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content ?? "";
}

async function callStructuredLocal<T>(opts: StructuredCallOptions<T>): Promise<T> {
  const schema = zodToJsonSchema(opts.tool.schema);
  const system = [
    opts.system,
    ...(opts.cachedContext ?? []).map((b) => `## ${b.label}\n${b.text}`),
    `Respond with ONLY a JSON object that matches this JSON schema — no prose, no markdown fences:\n${JSON.stringify(schema)}`,
  ].join("\n\n");
  const raw = await localChat(opts.model, system, opts.userPrompt, opts.maxTokens ?? 2048, true);
  return opts.tool.schema.parse(JSON.parse(extractJson(raw)));
}

async function callTextLocal(opts: {
  model: string;
  system: string;
  cachedContext?: CachedBlock[];
  userPrompt: string;
  maxTokens?: number;
}): Promise<string> {
  const system = [opts.system, ...(opts.cachedContext ?? []).map((b) => `## ${b.label}\n${b.text}`)].join("\n\n");
  return (await localChat(opts.model, system, opts.userPrompt, opts.maxTokens ?? 1500, false)).trim();
}

// ---- Claude Code CLI provider (subscription-billed) ----
//
// Model ids prefixed `claude-cli:` shell out to the locally-installed `claude` binary
// in headless print mode (`claude -p --output-format json`) instead of the API. Auth
// comes from the CLI's own login, so calls draw on the Claude plan's usage limits
// rather than API billing — no ANTHROPIC_API_KEY needed. Each invocation is stateless
// (fresh context every call), and `--max-turns 1` keeps it a pure completion: no tools,
// no file access, no agentic behavior. `claude-cli:sonnet` → `claude -p --model sonnet`;
// any alias/model id the CLI accepts works after the prefix.
//
// ANTHROPIC_API_KEY is stripped from the child env so a placeholder key in .env can't
// silently switch the CLI to (broken or unintended) API billing.

export function isClaudeCliModel(model: string): boolean {
  return model.startsWith("claude-cli:");
}

async function claudeCliChat(model: string, system: string, user: string): Promise<string> {
  const { execFile } = await import("node:child_process");
  const cliModel = model.slice("claude-cli:".length) || "sonnet";
  const childEnv = { ...process.env };
  delete childEnv.ANTHROPIC_API_KEY;

  return new Promise<string>((res, rej) => {
    const child = execFile(
      "claude",
      ["-p", "--output-format", "json", "--model", cliModel, "--max-turns", "1"],
      { env: childEnv, timeout: 300_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          return rej(new Error(`claude CLI failed: ${err.message}\n${String(stderr).slice(0, 500)}`));
        }
        try {
          const parsed = JSON.parse(stdout) as { result?: string; is_error?: boolean };
          if (parsed.is_error) return rej(new Error(`claude CLI error: ${parsed.result?.slice(0, 500)}`));
          res(parsed.result ?? "");
        } catch {
          rej(new Error(`claude CLI returned unparseable output: ${String(stdout).slice(0, 300)}`));
        }
      },
    );
    // Prompt goes over stdin so long JDs never hit argv length limits.
    child.stdin?.write(`${system}\n\n---\n\n${user}`);
    child.stdin?.end();
  });
}

async function callStructuredCli<T>(opts: StructuredCallOptions<T>): Promise<T> {
  const schema = zodToJsonSchema(opts.tool.schema);
  const system = [
    opts.system,
    ...(opts.cachedContext ?? []).map((b) => `## ${b.label}\n${b.text}`),
    `Respond with ONLY a JSON object that matches this JSON schema — no prose, no markdown fences:\n${JSON.stringify(schema)}`,
  ].join("\n\n");
  const raw = await claudeCliChat(opts.model, system, opts.userPrompt);
  return opts.tool.schema.parse(JSON.parse(extractJson(raw)));
}

async function callTextCli(opts: {
  model: string;
  system: string;
  cachedContext?: CachedBlock[];
  userPrompt: string;
  maxTokens?: number;
}): Promise<string> {
  const system = [opts.system, ...(opts.cachedContext ?? []).map((b) => `## ${b.label}\n${b.text}`)].join("\n\n");
  return (await claudeCliChat(opts.model, system, opts.userPrompt)).trim();
}
