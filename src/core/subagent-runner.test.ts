/**
 * Smoke test for the generic subagent runner.
 *
 * Stubs the Claude Agent SDK via __setQuery and asserts:
 *   - runSamples spawns N parallel queries (one per sample)
 *   - structured_output flows through to caller untouched
 *   - per-sample cost and turn accounting aggregates correctly
 *   - SDK errors land in the result with a non-empty errorReason
 */

import { describe, it, expect, afterEach } from "vitest";
import { runSamples, __setQuery, __resetQuery } from "./subagent-runner.js";

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

function fakeError(subtype: "error_during_execution" | "error_max_turns") {
  return (async function* () {
    yield {
      type: "result" as const,
      subtype,
      duration_ms: 10,
      duration_api_ms: 5,
      is_error: true,
      num_turns: 1,
      total_cost_usd: 0.002,
      usage: {} as never,
      modelUsage: {},
      permission_denials: [],
      errors: ["mock failure"],
      uuid: "test-uuid" as never,
      session_id: "test-session",
    };
  })();
}

const baseOpts = {
  systemPrompt: "you are a reviewer",
  userMessage: "review this",
  repoRoot: "/tmp",
  jsonSchema: { type: "object" } as Record<string, unknown>,
  tools: ["Read", "Grep"],
  model: "claude-opus-4-7",
  maxTurnsPerSample: 10,
  maxBudgetUsdPerSample: 1,
};

describe("subagent-runner", () => {
  afterEach(() => __resetQuery());

  it("runs N parallel samples and aggregates cost + turns", async () => {
    let calls = 0;
    __setQuery((() => {
      calls++;
      return fakeSuccess({ findings: [{ kind: "bug", line: 1 }] }, { costUsd: 0.05, turns: 4 });
    }) as never);

    const result = await runSamples({ ...baseOpts, samples: 3 });

    expect(calls).toBe(3);
    expect(result.samples).toHaveLength(3);
    expect(result.totalCostUsd).toBeCloseTo(0.15, 4);
    expect(result.totalTurns).toBe(12);
    for (const s of result.samples) {
      expect(s.structuredOutput).toEqual({ findings: [{ kind: "bug", line: 1 }] });
      expect(s.errorReason).toBeUndefined();
    }
  });

  it("captures SDK errors as errorReason without throwing", async () => {
    __setQuery((() => fakeError("error_max_turns")) as never);

    const result = await runSamples({ ...baseOpts, samples: 2 });

    expect(result.samples).toHaveLength(2);
    for (const s of result.samples) {
      expect(s.errorReason).toMatch(/error_max_turns/);
      expect(s.structuredOutput).toBeNull();
    }
    expect(result.totalCostUsd).toBeCloseTo(0.004, 4);
  });

  it("recovers structured output from fenced JSON if structured_output absent", async () => {
    __setQuery((() => {
      return (async function* () {
        yield {
          type: "result" as const,
          subtype: "success" as const,
          duration_ms: 10,
          duration_api_ms: 5,
          is_error: false,
          num_turns: 2,
          result: '```json\n{ "findings": [] }\n```',
          total_cost_usd: 0.01,
          usage: {} as never,
          modelUsage: {},
          permission_denials: [],
          structured_output: undefined,
          uuid: "test-uuid" as never,
          session_id: "test-session",
        };
      })();
    }) as never);

    const result = await runSamples({ ...baseOpts, samples: 1 });
    expect(result.samples[0]!.structuredOutput).toEqual({ findings: [] });
  });
});
