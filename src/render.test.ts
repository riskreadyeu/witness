/**
 * Tests for the terminal rendering layer.
 *
 * The interesting behavior here is `renderTotalFailure` — the path that
 * replaces the misleading "Witness has no findings." output when every
 * sample actually failed. We care that:
 *   - the headline says "all N samples failed", not "no findings"
 *   - error kinds are classified and counted
 *   - remediation tips map to the observed error kinds
 */

import { describe, it, expect } from "vitest";
import { classifyError, renderTotalFailure } from "./render.js";
import type { ParseError } from "./witness.js";

function pe(sampleIndex: number, error: string): ParseError {
  return { sampleIndex, error, detail: "" };
}

describe("classifyError", () => {
  it("recognizes budget-exhaustion errors", () => {
    expect(classifyError("agent error_max_budget_usd: ")).toBe("budget exhausted");
  });
  it("recognizes turn-exhaustion errors", () => {
    expect(classifyError("agent error_max_turns: 40 turns used")).toBe("turns exhausted");
  });
  it("recognizes zod/json validation errors", () => {
    expect(classifyError("json validation failed: [{...}]")).toBe(
      "json validation failed",
    );
  });
  it("recognizes a missing codex CLI", () => {
    expect(classifyError("sample failed Error: spawn codex ENOENT")).toBe("codex missing");
  });
  it("recognizes codex auth failures", () => {
    expect(classifyError("codex exited with code 1: not signed in")).toBe("codex auth");
  });
  it("falls back to unknown for novel errors", () => {
    expect(classifyError("ENOENT: spawn claude")).toBe("unknown");
  });
});

describe("renderTotalFailure", () => {
  it("leads with a loud total-failure headline, not 'no findings'", () => {
    const out = renderTotalFailure({
      samplesRequested: 3,
      totalTurns: 63,
      totalCostUsd: 1.02,
      elapsedMs: 55_400,
      parseErrors: [
        pe(0, "agent error_max_budget_usd: "),
        pe(1, "agent error_max_budget_usd: "),
        pe(2, "agent error_max_budget_usd: "),
      ],
    });

    expect(out).toMatch(/all 3 samples failed/);
    expect(out).not.toMatch(/has no findings/i);
    expect(out).toMatch(/\$1\.0200/);
    expect(out).toMatch(/63 turns/);
    expect(out).toMatch(/55\.4s/);
  });

  it("aggregates failure kinds and only suggests the remedies that apply", () => {
    const out = renderTotalFailure({
      samplesRequested: 3,
      totalTurns: 63,
      totalCostUsd: 1.02,
      elapsedMs: 55_400,
      parseErrors: [
        pe(0, "agent error_max_budget_usd: "),
        pe(1, "agent error_max_budget_usd: "),
        pe(2, "agent error_max_budget_usd: "),
      ],
    });

    expect(out).toMatch(/3× budget exhausted/);
    expect(out).toMatch(/--budget 2\.0/);
    // No turn failures => no turn-cap tip.
    expect(out).not.toMatch(/--max-turns/);
  });

  it("shows multiple remedies when failure modes are mixed", () => {
    const out = renderTotalFailure({
      samplesRequested: 3,
      totalTurns: 40,
      totalCostUsd: 0.5,
      elapsedMs: 30_000,
      parseErrors: [
        pe(0, "agent error_max_budget_usd: "),
        pe(1, "agent error_max_turns: "),
        pe(2, "json validation failed: bad"),
      ],
    });

    expect(out).toMatch(/1× budget exhausted/);
    expect(out).toMatch(/1× turns exhausted/);
    expect(out).toMatch(/1× json validation failed/);
    expect(out).toMatch(/--budget 2\.0/);
    expect(out).toMatch(/--max-turns 80/);
  });

  it("truncates the first-errors section to 3 entries", () => {
    const errors: ParseError[] = Array.from({ length: 10 }, (_, i) =>
      pe(i, `agent error_max_budget_usd: ${i}`),
    );
    const out = renderTotalFailure({
      samplesRequested: 10,
      totalTurns: 200,
      totalCostUsd: 5.0,
      elapsedMs: 120_000,
      parseErrors: errors,
    });

    // Exactly 3 "sample X:" lines, not 10.
    const sampleLines = out.match(/^  sample \d+:/gm) ?? [];
    expect(sampleLines.length).toBe(3);
  });
});
