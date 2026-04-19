/**
 * Smoke test for the Witness runtime.
 *
 * We don't hit the real Claude Agent SDK here — that requires credentials
 * and costs money. Instead we stub `query` via the `__setQuery` hook and
 * assert the pipeline works end-to-end: diff in -> merged findings out.
 *
 * What we're actually testing:
 *   - The review() function calls query() `samples` times (one per sample).
 *   - Structured output on the result message flows through Zod validation.
 *   - Multi-sample voting merges identical findings.
 *   - Model failures and invalid payloads go to `parseErrors`, not the crash.
 *   - Cost/turn metrics are aggregated across samples.
 */

import { describe, it, expect, afterEach } from "vitest";
import type { QueryFn } from "./witness.js";
import { review, __setQuery, __resetQuery } from "./witness.js";

/**
 * Build a fake Query (AsyncGenerator) that yields a single result message
 * with the provided structured_output. Mirrors the shape of
 * SDKResultMessage (subtype: 'success') just enough for our runtime.
 */
function fakeSuccess(structuredOutput: unknown, opts: { costUsd?: number; turns?: number } = {}) {
  return (async function* () {
    yield {
      type: "result" as const,
      subtype: "success" as const,
      duration_ms: 10,
      duration_api_ms: 5,
      is_error: false,
      num_turns: opts.turns ?? 3,
      result: typeof structuredOutput === "string" ? structuredOutput : JSON.stringify(structuredOutput),
      total_cost_usd: opts.costUsd ?? 0.01,
      usage: {} as never,
      modelUsage: {},
      permission_denials: [],
      structured_output: structuredOutput,
      uuid: "test-uuid" as never,
      session_id: "test-session",
    };
  })();
}

function fakeError(subtype: "error_during_execution" | "error_max_turns" | "error_max_budget_usd" | "error_max_structured_output_retries", errors: string[] = ["oops"]) {
  return (async function* () {
    yield {
      type: "result" as const,
      subtype,
      duration_ms: 10,
      duration_api_ms: 5,
      is_error: true,
      num_turns: 1,
      total_cost_usd: 0.001,
      usage: {} as never,
      modelUsage: {},
      permission_denials: [],
      errors,
      uuid: "test-uuid" as never,
      session_id: "test-session",
    };
  })();
}

const FINDING_A = {
  kind: "bug",
  severity: "high",
  file: "src/user.ts",
  startLine: 42,
  endLine: 42,
  title: "missing await on async call",
  why: "Line 42 returns a promise that will resolve after the function exits.",
  confidence: "high",
};

const FINDING_B = {
  kind: "security",
  severity: "critical",
  file: "src/auth.ts",
  startLine: 10,
  endLine: 12,
  title: "hardcoded API token",
  why: "Token is inlined as a constant; rotate and move to env.",
  confidence: "high",
};

afterEach(() => {
  __resetQuery();
});

describe("review()", () => {
  it("runs N parallel samples and merges identical findings", async () => {
    const samplesSeen: string[] = [];
    const fake: QueryFn = ((args: { prompt: unknown }) => {
      samplesSeen.push(typeof args.prompt === "string" ? "s" : "iter");
      return fakeSuccess({ findings: [FINDING_A] }) as ReturnType<QueryFn>;
    }) as unknown as QueryFn;
    __setQuery(fake);

    const result = await review({
      diff: `diff --git a/src/user.ts b/src/user.ts\n+++ b/src/user.ts\n@@\n+foo\n`,
      repoRoot: "/tmp/does-not-matter",
      samples: 3,
      minVotes: 2,
    });

    expect(samplesSeen.length).toBe(3);
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
    const fake: QueryFn = ((() => {
      // Sample 0 and 1: FINDING_A. Sample 2: FINDING_B alone.
      const payload = n++ < 2 ? [FINDING_A] : [FINDING_B];
      return fakeSuccess({ findings: payload }) as ReturnType<QueryFn>;
    }) as unknown) as QueryFn;
    __setQuery(fake);

    const result = await review({
      diff: "diff --git a/x b/x\n+++ b/x\n+foo\n",
      repoRoot: "/tmp",
      samples: 3,
      minVotes: 2,
    });

    expect(result.findings.length).toBe(1);
    expect(result.findings[0]?.file).toBe(FINDING_A.file);
    // FINDING_B has only 1 vote — below minVotes=2 — so it's dropped from
    // the surfaced list but still available in raw.samples.
    expect(result.raw.samples.flat().some((f) => f.file === FINDING_B.file)).toBe(true);
  });

  it("routes SDK error messages to parseErrors without crashing", async () => {
    let n = 0;
    const fake: QueryFn = ((() => {
      if (n++ === 0) return fakeError("error_max_turns", ["turn cap hit"]) as ReturnType<QueryFn>;
      return fakeSuccess({ findings: [FINDING_A] }) as ReturnType<QueryFn>;
    }) as unknown) as QueryFn;
    __setQuery(fake);

    const result = await review({
      diff: "diff --git a/x b/x\n+++ b/x\n+foo\n",
      repoRoot: "/tmp",
      samples: 2,
      minVotes: 1,
    });

    expect(result.meta.samplesParsed).toBe(1);
    expect(result.raw.parseErrors.length).toBe(1);
    expect(result.raw.parseErrors[0]?.error).toMatch(/error_max_turns/);
    expect(result.findings.length).toBe(1);
  });

  it("rejects structured output that fails Zod validation", async () => {
    const fake: QueryFn = ((() =>
      fakeSuccess({
        findings: [
          {
            ...FINDING_A,
            kind: "not-a-valid-kind",
          },
        ],
      }) as ReturnType<QueryFn>) as unknown) as QueryFn;
    __setQuery(fake);

    const result = await review({
      diff: "diff --git a/x b/x\n+++ b/x\n+foo\n",
      repoRoot: "/tmp",
      samples: 1,
      minVotes: 1,
    });

    expect(result.meta.samplesParsed).toBe(0);
    expect(result.raw.parseErrors.length).toBe(1);
    expect(result.raw.parseErrors[0]?.error).toMatch(/zod/i);
  });

  it("thrown errors from the SDK are captured, not rethrown", async () => {
    const fake: QueryFn = (() => {
      throw new Error("ENOENT: spawn claude");
    }) as unknown as QueryFn;
    __setQuery(fake);

    const result = await review({
      diff: "diff --git a/x b/x\n+++ b/x\n+foo\n",
      repoRoot: "/tmp",
      samples: 2,
      minVotes: 1,
    });

    expect(result.meta.samplesParsed).toBe(0);
    expect(result.raw.parseErrors.length).toBe(2);
    expect(result.raw.parseErrors[0]?.error).toBe("sample failed");
    expect(result.raw.parseErrors[0]?.detail).toMatch(/ENOENT/);
  });
});
