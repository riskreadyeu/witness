/**
 * Spec stage runtime.
 *
 * Reviews a markdown spec / PRD / ADR via N parallel SDK queries on the
 * shared core/subagent-runner. Stage-owned: prompt, schema, finding kinds,
 * line-based stable ID. Runner-owned: Promise.all parallelism, SDK
 * invocation, structured-output extraction.
 *
 * Authentication is delegated to the SDK (same path as the diff stage).
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
  type SubagentSampleResult,
} from "../../core/subagent-runner.js";
import {
  type AuthMode,
  type AuthOverride,
  defaultBudgetForAuth,
  detectAuth,
} from "../../core/auth.js";

export interface SpecReviewOptions {
  /** The full markdown text of the spec being reviewed. */
  spec: string;
  /** Absolute or repo-relative path of the spec file (used in the user message). */
  specPath: string;
  /**
   * Directory the agent's Read/Grep tools are rooted at — typically the
   * repo containing the spec, so the model can verify cross-references.
   */
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
  };
}

export interface ParseError {
  sampleIndex: number;
  error: string;
  detail: string;
}

const DEFAULTS = {
  model: "claude-opus-4-7",
  samples: 3,
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
    jsonSchema: reviewResponseJsonSchema as Record<string, unknown>,
    tools: ["Read", "Grep"],
    model,
    maxTurnsPerSample: maxTurns,
    maxBudgetUsdPerSample,
    samples,
  });

  const parseErrors: ParseError[] = [];
  const parsed: Finding[][] = [];

  runResult.samples.forEach((s: SubagentSampleResult, index: number) => {
    if (s.structuredOutput === null) {
      parseErrors.push({
        sampleIndex: index,
        error: s.errorReason ?? "no structured_output",
        detail: s.rawText ?? "",
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
    },
  };
}

function renderUserMessage(spec: string, specPath: string): string {
  // Number every line so the model can cite line numbers accurately.
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
    `Return a JSON object \`{ findings: Finding[] }\`. An empty array is`,
    `a valid response — a clean spec is a real outcome.`,
  ].join("\n");
}
