/**
 * Spec stage runtime — v0.4: uses core/claude-direct-runner so all N
 * samples share a cache_control marker on the system prompt + initial
 * user-message artifact block. Sample 1 writes the cache; samples 2..N
 * read it at 10% of input price.
 *
 * Auth: delegated to claude-direct-runner.resolveAuth (env var or the
 * OAuth bearer from ~/.claude/.credentials.json).
 */

import { SYSTEM_PROMPT } from "./prompt.js";
import {
  ReviewResponseSchema,
  type Finding,
  type VotedFinding,
} from "./schema.js";
import { reviewResponseJsonSchema } from "./json-schema.js";
import { mergeSamples } from "./voting.js";
import {
  runSamples,
  type DirectSampleResult,
} from "../../core/claude-direct-runner.js";
import {
  type AuthMode,
  type AuthOverride,
  defaultBudgetForAuth,
  detectAuth,
} from "../../core/auth.js";

export interface SpecReviewOptions {
  spec: string;
  specPath: string;
  repoRoot: string;
  model?: string;
  samples?: number;
  minVotes?: number;
  maxTurnsPerSample?: number;
  maxBudgetUsdPerSample?: number;
  authOverride?: AuthOverride;
}

export interface SpecReviewResult {
  findings: VotedFinding[];
  raw: {
    samples: Finding[][];
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
    auth: AuthMode;
    budgetUsdPerSample: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
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
  maxTurnsPerSample: 30,
};

export async function review(opts: SpecReviewOptions): Promise<SpecReviewResult> {
  const started = Date.now();
  const model = opts.model ?? DEFAULTS.model;
  const samples = opts.samples ?? DEFAULTS.samples;
  const minVotes = opts.minVotes ?? DEFAULTS.minVotes;
  const maxTurns = opts.maxTurnsPerSample ?? DEFAULTS.maxTurnsPerSample;
  const auth = detectAuth(opts.authOverride);
  const maxBudgetUsdPerSample =
    opts.maxBudgetUsdPerSample ?? defaultBudgetForAuth(auth);

  const userMessage = renderUserMessage(opts.spec, opts.specPath);

  const runResult = await runSamples({
    systemPrompt: SYSTEM_PROMPT,
    userMessage,
    repoRoot: opts.repoRoot,
    outputSchema: reviewResponseJsonSchema as Record<string, unknown>,
    tools: ["Read", "Grep"],
    model,
    maxTurnsPerSample: maxTurns,
    maxBudgetUsdPerSample,
    samples,
  });

  const parseErrors: ParseError[] = [];
  const parsed: Finding[][] = [];

  runResult.samples.forEach((s: DirectSampleResult, index: number) => {
    if (s.structuredOutput === null) {
      parseErrors.push({
        sampleIndex: index,
        error: s.errorReason ?? "no structured_output",
        detail: `cost=$${s.costUsd.toFixed(4)} turns=${s.turns}`,
      });
      return;
    }
    const validated = ReviewResponseSchema.safeParse(s.structuredOutput);
    if (!validated.success) {
      parseErrors.push({
        sampleIndex: index,
        error: `zod validation failed: ${validated.error.message}`,
        detail: JSON.stringify(s.structuredOutput).slice(0, 2000),
      });
      return;
    }
    parsed.push(validated.data.findings);
  });

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
      totalCostUsd: runResult.totalCostUsd,
      totalTurns: runResult.totalTurns,
      elapsedMs: Date.now() - started,
      auth,
      budgetUsdPerSample: maxBudgetUsdPerSample,
      cacheCreationTokens: runResult.totalCacheCreationTokens,
      cacheReadTokens: runResult.totalCacheReadTokens,
    },
  };
}

function renderUserMessage(spec: string, specPath: string): string {
  const numbered = spec
    .split("\n")
    .map((line, i) => `${String(i + 1).padStart(4, " ")}  ${line}`)
    .join("\n");

  return [
    `# Spec under review`,
    ``,
    `Path: \`${specPath}\``,
    ``,
    `The spec is reproduced below with line numbers. Use them in findings.`,
    ``,
    "```",
    numbered,
    "```",
    ``,
    `You have Read and Grep rooted at the repo containing this spec. Use`,
    `Grep to verify referenced files / symbols actually exist before`,
    `flagging \`broken-reference\`. Use Grep on the spec itself before`,
    `flagging \`undefined-term\` (the term may be defined elsewhere).`,
    ``,
    `When you are done investigating, call the submit_findings tool with`,
    `the findings array. An empty array is a valid response — a clean spec`,
    `is a real outcome. Call submit_findings exactly ONCE.`,
  ].join("\n");
}
