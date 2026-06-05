/**
 * Smoke test for the Witness runtime.
 *
 * We don't hit real model backends here. Instead we inject fake
 * ReviewerBackend implementations and assert the pipeline works end-to-end:
 * diff in -> merged findings out.
 *
 * What we're actually testing:
 *   - The review() function calls runSample() `samples` times (one per sample).
 *   - Multi-sample voting merges identical findings.
 *   - Backend failures and invalid payloads go to `parseErrors`, not the crash.
 *   - Cost/turn metrics are aggregated across samples.
 */

import { describe, it, expect, afterEach } from "vitest";
import { review } from "./witness.js";
import type { BackendSampleResult, ReviewerBackend } from "./backend.js";
import type { Recommendation } from "../../core/schema.js";
import { __setRunSamples, __resetRunSamples } from "../../core/runner-dispatch.js";
import type { RunResult } from "../../core/runner-types.js";

const FINDING_A = {
  kind: "bug",
  severity: "high",
  file: "src/user.ts",
  startLine: 42,
  endLine: 42,
  title: "missing await on async call",
  why: "Line 42 returns a promise that will resolve after the function exits.",
  confidence: "high",
} as const;

const FINDING_B = {
  kind: "security",
  severity: "critical",
  file: "src/auth.ts",
  startLine: 10,
  endLine: 12,
  title: "hardcoded API token",
  why: "Token is inlined as a constant; rotate and move to env.",
  confidence: "high",
} as const;

function successResult(
  findings: Recommendation[],
  opts: { costUsd?: number; turns?: number } = {},
): BackendSampleResult {
  return {
    findings,
    costUsd: opts.costUsd ?? 0.01,
    turns: opts.turns ?? 3,
  };
}

describe("review()", () => {
  it("runs N parallel samples and merges identical findings", async () => {
    const prompts: string[] = [];
    const backend: ReviewerBackend = {
      async runSample({ prompt }) {
        prompts.push(prompt);
        return successResult([FINDING_A]);
      },
    };

    const result = await review({
      diff: `diff --git a/src/user.ts b/src/user.ts\n+++ b/src/user.ts\n@@\n+foo\n`,
      repoRoot: "/tmp/does-not-matter",
      samples: 3,
      minVotes: 2,
      reviewerBackend: backend,
    });

    expect(prompts).toHaveLength(3);
    expect(result.meta.samplesRequested).toBe(3);
    expect(result.meta.samplesParsed).toBe(3);
    expect(result.findings.length).toBe(1);
    expect(result.findings[0]?.votes).toBe(3);
    expect(result.findings[0]?.totalSamples).toBe(3);
    expect(result.findings[0]?.kind).toBe("bug");
    expect(result.meta.totalCostUsd).toBeCloseTo(0.03, 6);
    expect(result.meta.totalTurns).toBe(9);
  });

  it("filters out findings below the minVotes threshold", async () => {
    let n = 0;
    const backend: ReviewerBackend = {
      async runSample() {
        return successResult(n++ < 2 ? [FINDING_A] : [FINDING_B]);
      },
    };

    const result = await review({
      diff: "diff --git a/x b/x\n+++ b/x\n+foo\n",
      repoRoot: "/tmp",
      samples: 3,
      minVotes: 2,
      reviewerBackend: backend,
    });

    expect(result.findings.length).toBe(1);
    expect(result.findings[0]?.file).toBe(FINDING_A.file);
    // FINDING_B has only 1 vote — below minVotes=2 — so it's dropped from
    // the surfaced list but still available in raw.samples.
    expect(result.raw.samples.flat().some((f) => f.file === FINDING_B.file)).toBe(true);
  });

  it("routes backend error results to parseErrors without crashing", async () => {
    let n = 0;
    const backend: ReviewerBackend = {
      async runSample() {
        if (n++ === 0) {
          return {
            findings: null,
            costUsd: 0.001,
            turns: 1,
            errorReason: "error_max_turns: turn cap hit",
          };
        }
        return successResult([FINDING_A]);
      },
    };

    const result = await review({
      diff: "diff --git a/x b/x\n+++ b/x\n+foo\n",
      repoRoot: "/tmp",
      samples: 2,
      minVotes: 1,
      reviewerBackend: backend,
    });

    expect(result.meta.samplesParsed).toBe(1);
    expect(result.raw.parseErrors.length).toBe(1);
    expect(result.raw.parseErrors[0]?.error).toMatch(/error_max_turns/);
    expect(result.findings.length).toBe(1);
  });

  it("rejects structured output that fails Zod validation", async () => {
    const backend: ReviewerBackend = {
      async runSample() {
        return {
          findings: null,
          costUsd: 0.01,
          turns: 3,
          errorReason: "zod validation failed: invalid union discriminator",
        };
      },
    };

    const result = await review({
      diff: "diff --git a/x b/x\n+++ b/x\n+foo\n",
      repoRoot: "/tmp",
      samples: 1,
      minVotes: 1,
      reviewerBackend: backend,
    });

    expect(result.meta.samplesParsed).toBe(0);
    expect(result.raw.parseErrors.length).toBe(1);
    expect(result.raw.parseErrors[0]?.error).toMatch(/zod/i);
  });

  it("thrown errors from the backend are captured, not rethrown", async () => {
    const backend: ReviewerBackend = {
      async runSample() {
        throw new Error("ENOENT: spawn claude");
      },
    };

    const result = await review({
      diff: "diff --git a/x b/x\n+++ b/x\n+foo\n",
      repoRoot: "/tmp",
      samples: 2,
      minVotes: 1,
      reviewerBackend: backend,
    });

    expect(result.meta.samplesParsed).toBe(0);
    expect(result.raw.parseErrors.length).toBe(2);
    expect(result.raw.parseErrors[0]?.error).toBe("sample failed");
    expect(result.raw.parseErrors[0]?.detail).toMatch(/ENOENT/);
  });

  it("can run samples through an injected reviewer backend", async () => {
    const prompts: string[] = [];
    const backend: ReviewerBackend = {
      async runSample({ prompt }) {
        prompts.push(prompt);
        return {
          findings: [FINDING_A],
          costUsd: 0,
          turns: 0,
        };
      },
    };

    const result = await review({
      diff: `diff --git a/src/user.ts b/src/user.ts\n+++ b/src/user.ts\n@@\n+foo\n`,
      repoRoot: "/tmp",
      samples: 2,
      minVotes: 2,
      reviewerBackend: backend,
    });

    expect(prompts).toHaveLength(2);
    expect(result.meta.backend).toBe("custom");
    expect(result.meta.samplesParsed).toBe(2);
    expect(result.findings[0]?.votes).toBe(2);
  });
});

// ── Dispatcher path (makeDispatcherBackend) ──────────────────────────────────
// These tests drive review() WITHOUT a reviewerBackend so the dispatcher
// wiring in makeDispatcherBackend is actually exercised.

function fakeRunResult(structuredOutput: unknown, costUsd = 0.01, turns = 3): RunResult {
  return {
    samples: [{
      structuredOutput,
      costUsd,
      turns,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    }],
    totalCostUsd: costUsd,
    totalTurns: turns,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    provider: "anthropic",
  };
}

describe("review() via makeDispatcherBackend (no reviewerBackend injected)", () => {
  afterEach(() => __resetRunSamples());

  it("routes through dispatcher and returns merged findings", async () => {
    __setRunSamples(async () => fakeRunResult({ findings: [FINDING_A] }));
    const result = await review({
      diff: "diff --git a/x b/x\n+++ b/x\n+foo\n",
      repoRoot: "/tmp",
      samples: 2,
      minVotes: 2,
    });
    expect(result.meta.backend).toBe("claude");
    expect(result.findings.length).toBe(1);
    expect(result.findings[0]?.votes).toBe(2);
    expect(result.meta.totalCostUsd).toBeCloseTo(0.02, 6);
  });

  it("routes dispatcher null structuredOutput to parseErrors", async () => {
    __setRunSamples(async () => fakeRunResult(null));
    const result = await review({
      diff: "diff --git a/x b/x\n+++ b/x\n+foo\n",
      repoRoot: "/tmp",
      samples: 1,
      minVotes: 1,
    });
    expect(result.meta.samplesParsed).toBe(0);
    expect(result.raw.parseErrors.length).toBe(1);
  });
});
