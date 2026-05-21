/**
 * Shared types for review runners.
 *
 * One interface, multiple provider implementations:
 *   - claude-direct-runner.ts  (Anthropic, @anthropic-ai/sdk)
 *   - gemini-runner.ts         (Google, @google/genai)
 *   - (future)                 OpenAI, custom local models, etc.
 *
 * Stages call runner-dispatch.ts, which selects the implementation based
 * on the model string prefix. Stages never import a provider runner
 * directly — that's what makes adding a new provider cheap.
 */

export interface RunnerOptions {
  systemPrompt: string;
  userMessage: string;
  repoRoot: string;
  /** JSON schema for structured output (the submit_findings tool / responseSchema). */
  outputSchema: Record<string, unknown>;
  /** Read-only tools the runner may expose to the model: Read, Grep, Glob. */
  tools: string[];
  /** Model identifier — used both to call the API AND to dispatch to the right runner. */
  model: string;
  maxTurnsPerSample: number;
  maxBudgetUsdPerSample: number;
  samples: number;
}

export interface SampleResult {
  /** Parsed structured output from the model. null on any failure path. */
  structuredOutput: unknown | null;
  costUsd: number;
  turns: number;
  /** Tokens written to provider's prompt cache during this sample (if any). */
  cacheCreationTokens: number;
  /** Tokens read from the prompt cache during this sample (if any). */
  cacheReadTokens: number;
  /** Optional reason if structuredOutput is null. */
  errorReason?: string;
}

export interface RunResult {
  samples: SampleResult[];
  totalCostUsd: number;
  totalTurns: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  /** Which provider actually served the request: "anthropic" | "google" | future. */
  provider: string;
}

/**
 * A runner takes RunnerOptions and produces a RunResult. Stage code holds
 * one of these via the dispatcher; never knows which provider answered.
 */
export interface ReviewRunner {
  runSamples(opts: RunnerOptions): Promise<RunResult>;
}
