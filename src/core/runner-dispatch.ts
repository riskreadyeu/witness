/**
 * Runner dispatcher — picks the right provider implementation for a model.
 *
 * Selection rule, in order:
 *   1. Explicit override via opts.provider ("anthropic" | "google")
 *   2. Model-string prefix:
 *        claude-*   → anthropic
 *        gemini-*   → google
 *   3. Default → anthropic (preserves existing behavior for unknown models)
 *
 * Stages call runSamples(opts) here, never a provider-specific runner.
 * Adding a new provider:
 *   1. Write src/core/<name>-runner.ts implementing ReviewRunner
 *   2. Add a prefix → factory mapping below
 *   3. Done — no stage code changes
 */

import { ClaudeDirectRunner } from "./claude-direct-runner.js";
import { GeminiRunner } from "./gemini-runner.js";
import type { ReviewRunner, RunnerOptions, RunResult } from "./runner-types.js";

export type ProviderName = "anthropic" | "google";

export interface DispatchOptions extends RunnerOptions {
  /** Override the auto-selected provider. */
  provider?: ProviderName;
}

function pickProvider(model: string, override?: ProviderName): ProviderName {
  if (override) return override;
  if (model.startsWith("gemini-")) return "google";
  if (model.startsWith("claude-")) return "anthropic";
  return "anthropic";
}

const REGISTRY: Record<ProviderName, () => ReviewRunner> = {
  anthropic: () => new ClaudeDirectRunner(),
  google: () => new GeminiRunner(),
};

export async function runSamples(opts: DispatchOptions): Promise<RunResult> {
  const provider = pickProvider(opts.model, opts.provider);
  const runner = REGISTRY[provider]();
  return runner.runSamples(opts);
}
