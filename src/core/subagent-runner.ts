/**
 * Generic subagent runner.
 *
 * One-call-per-sample wrapper around the Claude Agent SDK. Stage-agnostic —
 * the stage owns the system prompt, the user message, the JSON schema, and
 * the read-only tool set; this module owns the Promise.all parallelism,
 * the SDK invocation, the structured-output extraction, and the per-sample
 * accounting.
 *
 * The SDK is given:
 *   - constrained tools (Read/Grep, plus Glob for diff stage)
 *   - settingSources: []        — don't load user CLAUDE.md
 *   - persistSession: false     — don't pollute ~/.claude/projects
 *   - outputFormat: json_schema — structured output with SDK-side parsing
 *
 * Authentication is delegated to the SDK entirely (subscription via
 * `claude login` or ANTHROPIC_API_KEY env var). This module never touches
 * credentials.
 *
 * No prompt-cache wiring is exposed at this layer: the SDK manages the
 * underlying API call shape. If/when the SDK surfaces explicit
 * `cache_control` for system prompts, plumb it here.
 */

import { query, type Options } from "@anthropic-ai/claude-agent-sdk";

export interface SubagentRunOptions {
  systemPrompt: string;
  userMessage: string;
  repoRoot: string;
  jsonSchema: Record<string, unknown>;
  /** Read-only tools the SDK is allowed to use. Caller's responsibility to keep this read-only. */
  tools: string[];
  model: string;
  maxTurnsPerSample: number;
  maxBudgetUsdPerSample: number;
  samples: number;
}

export interface SubagentSampleResult {
  /** Parsed JSON object returned by the agent (schema-validated by the SDK). null on failure. */
  structuredOutput: unknown | null;
  costUsd: number;
  turns: number;
  errorReason?: string;
  rawText?: string;
}

export interface SubagentRunResult {
  samples: SubagentSampleResult[];
  totalCostUsd: number;
  totalTurns: number;
}

/** Test injection point. */
export type QueryFn = typeof query;
let _query: QueryFn = query;
/** Swap the SDK query function. For tests only. */
export function __setQuery(fn: QueryFn): void { _query = fn; }
/** Restore the default. For tests only. */
export function __resetQuery(): void { _query = query; }

/**
 * Run N independent samples in parallel against the SDK. Each sample is a
 * fresh session; the stage's systemPrompt is sent verbatim each call.
 *
 * The SDK's `maxBudgetUsd` is per-query and we run one query per sample,
 * so total run cost is bounded by `maxBudgetUsdPerSample * samples`.
 * That contract stays visible to callers — no silent budget/samples
 * division that starves the agent on real diffs.
 */
export async function runSamples(opts: SubagentRunOptions): Promise<SubagentRunResult> {
  const queryOptions: Options = {
    model: opts.model,
    cwd: opts.repoRoot,
    systemPrompt: opts.systemPrompt,
    tools: opts.tools,
    allowedTools: opts.tools,
    permissionMode: "default",
    settingSources: [],
    persistSession: false,
    maxTurns: opts.maxTurnsPerSample,
    maxBudgetUsd: opts.maxBudgetUsdPerSample,
    outputFormat: {
      type: "json_schema",
      schema: opts.jsonSchema,
    },
  };

  const settled = await Promise.all(
    Array.from({ length: opts.samples }, () => runOne(opts.userMessage, queryOptions)),
  );

  return {
    samples: settled,
    totalCostUsd: settled.reduce((a, s) => a + s.costUsd, 0),
    totalTurns: settled.reduce((a, s) => a + s.turns, 0),
  };
}

async function runOne(prompt: string, options: Options): Promise<SubagentSampleResult> {
  let structuredOutput: unknown = null;
  let rawResultText = "";
  let errorReason: string | undefined;
  let costUsd = 0;
  let turns = 0;

  try {
    for await (const msg of _query({ prompt, options })) {
      if (msg.type !== "result") continue;
      costUsd = msg.total_cost_usd;
      turns = msg.num_turns;
      if (msg.subtype === "success") {
        structuredOutput = msg.structured_output ?? tryExtractJson(msg.result);
        rawResultText = msg.result;
      } else {
        errorReason = `agent ${msg.subtype}: ${msg.errors.join(" | ")}`;
      }
    }
  } catch (err) {
    errorReason = err instanceof Error ? err.message : String(err);
  }

  const result: SubagentSampleResult = { structuredOutput, costUsd, turns };
  if (errorReason !== undefined) result.errorReason = errorReason;
  if (rawResultText !== "") result.rawText = rawResultText;
  return result;
}

/**
 * Defensive parser in case the SDK doesn't populate `structured_output`
 * (older runtimes, or schema retries exhausted). Strips optional code
 * fences and plucks the outermost {...} block. The previous regex used
 * non-greedy capture that truncated nested JSON like `{ "findings": [...] }`
 * at the first inner `}`, which is exactly the shape this fallback exists
 * to recover.
 */
function tryExtractJson(text: string): unknown {
  const stripped = text.replace(/^\s*```(?:json)?\s*\n?|\n?\s*```\s*$/g, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;
  try {
    return JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return undefined;
  }
}
