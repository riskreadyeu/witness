/**
 * Witness runtime.
 *
 * Thin wrapper around the shared runner dispatcher:
 *   1. N parallel backend.runSample() calls (Promise.all). Each sample is isolated.
 *   2. The Claude path delegates to core/runner-dispatch, which picks the provider
 *      from the model prefix and owns structured-output extraction.
 *   3. Results are Zod-validated (defense in depth: runner schema + our
 *      stricter discriminated union).
 *   4. Findings are merged with stable-ID voting.
 */

import { SYSTEM_PROMPT } from "./prompt.js";
import {
  ReviewResponseSchema,
  type Recommendation,
  type VotedRecommendation,
} from "../../core/schema.js";
import { reviewResponseJsonSchema } from "../../core/json-schema.js";
import { runSamples } from "../../core/runner-dispatch.js";
import { mergeSamples } from "../../core/voting.js";
import { buildContext, renderUserMessage } from "./diff.js";
import type { BackendKind, ReviewerBackend } from "./backend.js";
import { CodexCliBackend } from "./codex-backend.js";
import { type AuthMode, type AuthOverride, defaultBudgetForAuth, detectAuth } from "../../core/auth.js";

export interface WitnessOptions {
  diff: string;
  repoRoot: string;
  model?: string;
  samples?: number;
  minVotes?: number;
  maxTurnsPerSample?: number;
  /**
   * USD cap applied to EACH sample independently. Total spend for a run
   * is bounded by `maxBudgetUsdPerSample * samples`.
   */
  maxBudgetUsdPerSample?: number;
  /**
   * Override auth detection. "auto" runs detection; "subscription" / "api-key"
   * force a mode. The mode only affects the default budget — the selected
   * runner still picks credentials its own way.
   */
  authOverride?: AuthOverride;
  backend?: BackendKind;
  /**
   * Injection point for tests or embedded callers that want to provide
   * their own read-only reviewer backend.
   */
  reviewerBackend?: ReviewerBackend;
}

export interface WitnessResult {
  findings: VotedRecommendation[];
  raw: {
    samples: Recommendation[][];
    parseErrors: ParseError[];
  };
  meta: {
    /**
     * Model identifier we ran with. `null` means we genuinely don't know —
     * happens with the codex backend when the user hasn't passed --model
     * and codex picks from its own config. Don't replace this with a
     * placeholder string; downstream renderers depend on the null to
     * decide whether to show a model fragment at all.
     */
    model: string | null;
    samplesRequested: number;
    samplesParsed: number;
    minVotes: number;
    totalCostUsd: number;
    totalTurns: number;
    elapsedMs: number;
    backend: BackendKind | "custom";
    auth: AuthMode;
    /** The actual per-sample budget that was applied (defaulted or set). */
    budgetUsdPerSample: number;
  };
}

export interface ParseError {
  sampleIndex: number;
  error: string;
  detail: string;
}

const DEFAULTS = {
  model: "claude-opus-4-7",
  samples: 2,
  minVotes: 2,
  maxTurnsPerSample: 40,
};

export async function review(opts: WitnessOptions): Promise<WitnessResult> {
  const started = Date.now();
  const backendKind = opts.backend ?? "claude";
  // Resolve the model. For Claude, we always know it (default or overridden).
  // For Codex without --model, we don't — codex picks from its own config
  // and we have no honest way to label it from our side.
  const backendModel = opts.model ?? (backendKind === "claude" ? DEFAULTS.model : undefined);
  const model: string | null = backendModel ?? null;
  const samples = opts.samples ?? DEFAULTS.samples;
  const minVotes = opts.minVotes ?? DEFAULTS.minVotes;
  const maxTurns = opts.maxTurnsPerSample ?? DEFAULTS.maxTurnsPerSample;
  const auth = detectAuth(opts.authOverride);
  const maxBudgetUsdPerSample =
    opts.maxBudgetUsdPerSample ?? defaultBudgetForAuth(auth);

  const context = buildContext({ diff: opts.diff, repoRoot: opts.repoRoot });
  const userMessage = renderUserMessage(context, backendKind);

  // The budget is per sample, and we run one backend call per sample. We
  // keep that contract visible to callers instead of hiding a silent
  // `/samples` division, which footgunned us into starving real-world
  // refactors on the default budget. Total run cost is bounded by
  // `maxBudgetUsdPerSample * samples` — report that honestly upstream.
  const reviewerBackend =
    opts.reviewerBackend ??
    (backendKind === "codex"
      ? new CodexCliBackend()
      : makeDispatcherBackend({
          model: model ?? DEFAULTS.model,
          repoRoot: opts.repoRoot,
          maxTurns,
          maxBudgetUsdPerSample,
        }));

  const settled = await Promise.all(
    Array.from({ length: samples }, (_, i) =>
      reviewerBackend.runSample({
        prompt: userMessage,
        repoRoot: opts.repoRoot,
        ...(backendModel !== undefined ? { model: backendModel } : {}),
        maxTurns,
        maxBudgetUsd: maxBudgetUsdPerSample,
      }).then(
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
      backend: opts.reviewerBackend ? "custom" : backendKind,
      auth,
      budgetUsdPerSample: maxBudgetUsdPerSample,
    },
  };
}

function makeDispatcherBackend(params: {
  model: string;
  repoRoot: string;
  maxTurns: number;
  maxBudgetUsdPerSample: number;
}): ReviewerBackend {
  return {
    async runSample(options) {
      const runResult = await runSamples({
        systemPrompt: SYSTEM_PROMPT,
        userMessage: options.prompt,
        repoRoot: options.repoRoot,
        outputSchema: reviewResponseJsonSchema as Record<string, unknown>,
        tools: ["Read", "Grep", "Glob"],
        model: options.model ?? params.model,
        maxTurnsPerSample: options.maxTurns ?? params.maxTurns,
        maxBudgetUsdPerSample: options.maxBudgetUsd ?? params.maxBudgetUsdPerSample,
        samples: 1,
      });

      const sample = runResult.samples[0];
      if (!sample) {
        return {
          findings: null,
          costUsd: runResult.totalCostUsd,
          turns: runResult.totalTurns,
          errorReason: "dispatcher returned no sample",
        };
      }

      if (sample.structuredOutput === null) {
        return {
          findings: null,
          costUsd: sample.costUsd,
          turns: sample.turns,
          errorReason: sample.errorReason ?? "no structured output",
        };
      }

      const parsed = ReviewResponseSchema.safeParse(sample.structuredOutput);
      if (!parsed.success) {
        return {
          findings: null,
          costUsd: sample.costUsd,
          turns: sample.turns,
          errorReason: `zod validation failed: ${parsed.error.message}`,
          rawText: JSON.stringify(sample.structuredOutput).slice(0, 2000),
        };
      }

      return {
        findings: parsed.data.findings,
        costUsd: sample.costUsd,
        turns: sample.turns,
      };
    },
  };
}
