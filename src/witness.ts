/**
 * Witness runtime.
 *
 * Thin wrapper around the Claude Agent SDK:
 *   1. N parallel `query()` calls (Promise.all). Each is a fresh session.
 *   2. Per session we constrain tools to Read/Grep/Glob (read-only).
 *   3. We request structured output via JSON schema, so the SDK handles
 *      parsing + retries for us.
 *   4. Results are Zod-validated (defense in depth: SDK schema + our
 *      stricter discriminated union).
 *   5. Findings are merged with stable-ID voting.
 *
 * No subprocesses managed by us, no tool loops written by us, no regex
 * JSON extractor. The SDK owns the things it should own.
 *
 * Authentication is delegated to the SDK entirely:
 *   - If `claude login` has set up subscription OAuth, that's used.
 *   - Otherwise, `ANTHROPIC_API_KEY` from env.
 *   - Failing both, the SDK throws and we let the error propagate with
 *     a helpful prefix.
 */

import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { SYSTEM_PROMPT } from "./prompt.js";
import {
  ReviewResponseSchema,
  type Recommendation,
  type VotedRecommendation,
} from "./schema.js";
import { reviewResponseJsonSchema } from "./json-schema.js";
import { mergeSamples } from "./voting.js";
import { buildContext, renderUserMessage } from "./diff.js";

export interface WitnessOptions {
  diff: string;
  repoRoot: string;
  model?: string;
  samples?: number;
  minVotes?: number;
  maxTurnsPerSample?: number;
  /**
   * USD cap applied to EACH sample independently. Total spend for a run
   * is bounded by `maxBudgetUsdPerSample * samples`. Matches the SDK's
   * own `maxBudgetUsd` semantics, which is per-query.
   */
  maxBudgetUsdPerSample?: number;
}

export interface WitnessResult {
  findings: VotedRecommendation[];
  raw: {
    samples: Recommendation[][];
    parseErrors: ParseError[];
  };
  meta: {
    model: string;
    samplesRequested: number;
    samplesParsed: number;
    minVotes: number;
    totalCostUsd: number;
    totalTurns: number;
    elapsedMs: number;
  };
}

export interface ParseError {
  sampleIndex: number;
  error: string;
  detail: string;
}

const DEFAULTS = {
  model: "claude-sonnet-4-5-20250929",
  samples: 5,
  minVotes: 2,
  maxTurnsPerSample: 40,
  /**
   * Per-sample cap. Real-world multi-file diffs need room to Read/Grep
   * before emitting findings — empirically a 13 KB / 5-file refactor
   * burns ~$0.34/sample. $1.00/sample gives Sonnet the headroom to
   * actually finish, and the `--budget` flag is honest about what a
   * full run costs: budget × samples.
   */
  maxBudgetUsdPerSample: 1.0,
};

/**
 * Injection point for tests. We avoid DI frameworks — a plain
 * default-export function that tests can override at the module level.
 */
export type QueryFn = typeof query;
let _query: QueryFn = query;

/** Swap the SDK query function. For tests only. */
export function __setQuery(fn: QueryFn): void {
  _query = fn;
}
/** Restore the default. For tests only. */
export function __resetQuery(): void {
  _query = query;
}

export async function review(opts: WitnessOptions): Promise<WitnessResult> {
  const started = Date.now();
  const model = opts.model ?? DEFAULTS.model;
  const samples = opts.samples ?? DEFAULTS.samples;
  const minVotes = opts.minVotes ?? DEFAULTS.minVotes;
  const maxTurns = opts.maxTurnsPerSample ?? DEFAULTS.maxTurnsPerSample;
  const maxBudgetUsdPerSample =
    opts.maxBudgetUsdPerSample ?? DEFAULTS.maxBudgetUsdPerSample;

  const context = buildContext({ diff: opts.diff, repoRoot: opts.repoRoot });
  const userMessage = renderUserMessage(context);

  // The SDK's maxBudgetUsd is per-query, and we run one query per sample.
  // We keep that contract visible to callers instead of hiding a silent
  // `/samples` division, which footgunned us into starving real-world
  // refactors on the default budget. Total run cost is bounded by
  // `maxBudgetUsdPerSample * samples` — report that honestly upstream.
  const queryOptions: Options = {
    model,
    cwd: opts.repoRoot,
    systemPrompt: SYSTEM_PROMPT,
    tools: ["Read", "Grep", "Glob"],
    allowedTools: ["Read", "Grep", "Glob"],
    permissionMode: "default",
    settingSources: [], // SDK isolation mode: don't load user CLAUDE.md etc.
    persistSession: false, // don't litter ~/.claude/projects with our sessions
    maxTurns,
    maxBudgetUsd: maxBudgetUsdPerSample,
    outputFormat: {
      type: "json_schema",
      schema: reviewResponseJsonSchema as Record<string, unknown>,
    },
  };

  const settled = await Promise.all(
    Array.from({ length: samples }, (_, i) =>
      runSample(userMessage, queryOptions).then(
        (res) => ({ ok: true as const, index: i, ...res }),
        (err) => ({
          ok: false as const,
          index: i,
          error: err instanceof Error ? err : new Error(String(err)),
        }),
      ),
    ),
  );

  const parseErrors: ParseError[] = [];
  const parsed: Recommendation[][] = [];
  let totalCostUsd = 0;
  let totalTurns = 0;

  for (const s of settled) {
    if (!s.ok) {
      parseErrors.push({
        sampleIndex: s.index,
        error: "sample failed",
        detail: s.error.message,
      });
      continue;
    }
    totalCostUsd += s.costUsd;
    totalTurns += s.turns;
    if (!s.findings) {
      parseErrors.push({
        sampleIndex: s.index,
        error: s.errorReason ?? "no structured_output in result",
        detail: s.rawText ?? "",
      });
      continue;
    }
    parsed.push(s.findings);
  }

  const merged = mergeSamples(parsed);
  const findings = merged.filter((f) => f.votes >= minVotes);

  return {
    findings,
    raw: { samples: parsed, parseErrors },
    meta: {
      model,
      samplesRequested: samples,
      samplesParsed: parsed.length,
      minVotes,
      totalCostUsd,
      totalTurns,
      elapsedMs: Date.now() - started,
    },
  };
}

interface SampleSuccess {
  findings: Recommendation[] | null;
  costUsd: number;
  turns: number;
  errorReason?: string | undefined;
  rawText?: string | undefined;
}

async function runSample(
  prompt: string,
  options: Options,
): Promise<SampleSuccess> {
  let structuredOutput: unknown = undefined;
  let rawResultText = "";
  let errorReason: string | undefined;
  let costUsd = 0;
  let turns = 0;

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

  if (structuredOutput === undefined) {
    return { findings: null, costUsd, turns, errorReason: errorReason ?? "no result message emitted", rawText: rawResultText };
  }

  const parsed = ReviewResponseSchema.safeParse(structuredOutput);
  if (!parsed.success) {
    return {
      findings: null,
      costUsd,
      turns,
      errorReason: `zod validation failed: ${parsed.error.message}`,
      rawText: JSON.stringify(structuredOutput).slice(0, 2000),
    };
  }

  return { findings: parsed.data.findings, costUsd, turns };
}

/**
 * Defensive parser in case the SDK doesn't populate `structured_output`
 * (older runtimes, or schema retries exhausted). We fall back to trying
 * to pluck JSON out of the text result.
 */
function tryExtractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return undefined;
  }
}
