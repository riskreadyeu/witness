import type { Recommendation } from "./schema.js";

export type BackendKind = "claude" | "codex";

export interface ReviewerBackendOptions {
  prompt: string;
  repoRoot: string;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
}

export interface BackendSampleResult {
  findings: Recommendation[] | null;
  costUsd: number;
  turns: number;
  errorReason?: string | undefined;
  rawText?: string | undefined;
}

export interface ReviewerBackend {
  runSample(options: ReviewerBackendOptions): Promise<BackendSampleResult>;
}
