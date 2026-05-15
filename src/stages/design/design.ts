/**
 * design stage runtime.
 *
 * Reviews architecture markdown, design docs, ADRs (Mermaid/PlantUML diagrams ok) via N parallel SDK queries on the shared
 * core/subagent-runner. Stage-owned: prompt, schema, finding kinds,
 * line-based stable ID. Runner-owned: Promise.all parallelism, SDK
 * invocation, structured-output extraction.
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

export interface DesignReviewOptions {
  /** Full text of the artifact being reviewed. */
  artifact: string;
  /** Path of the artifact (used in the user message). */
  artifactPath: string;
  /** Directory the agent's tools are rooted at. */
  repoRoot: string;
  model?: string;
  samples?: number;
  minVotes?: number;
  maxTurnsPerSample?: number;
  maxBudgetUsdPerSample?: number;
  authOverride?: AuthOverride;
}

export interface DesignReviewResult {
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
  maxTurnsPerSample: 40,
};

export async function review(opts: DesignReviewOptions): Promise<DesignReviewResult> {
  const started = Date.now();
  const model = opts.model ?? DEFAULTS.model;
  const samples = opts.samples ?? DEFAULTS.samples;
  const minVotes = opts.minVotes ?? DEFAULTS.minVotes;
  const maxTurns = opts.maxTurnsPerSample ?? DEFAULTS.maxTurnsPerSample;
  const auth = detectAuth(opts.authOverride);
  const maxBudgetUsdPerSample =
    opts.maxBudgetUsdPerSample ?? defaultBudgetForAuth(auth);

  const userMessage = renderUserMessage(opts.artifact, opts.artifactPath);

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

function renderUserMessage(artifact: string, artifactPath: string): string {
  const numbered = artifact
    .split("\n")
    .map((line, i) => `${String(i + 1).padStart(4, " ")}  ${line}`)
    .join("\n");

  return [
    `# Artifact under review`,
    ``,
    `Path: \`${artifactPath}\``,
    ``,
    `The artifact is reproduced below with line numbers. Use them in findings.`,
    ``,
    "```",
    numbered,
    "```",
    ``,
    `Return a JSON object \`{ findings: Finding[] }\`. An empty array is a valid response.`,
  ].join("\n");
}
