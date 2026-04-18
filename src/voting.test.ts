import { describe, it, expect } from "vitest";
import { stableId, mergeSamples } from "./voting.js";
import type { Recommendation } from "./schema.js";

const rec = (over: Partial<Recommendation>): Recommendation => ({
  kind: "bug",
  severity: "high",
  file: "src/foo.ts",
  startLine: 10,
  endLine: 10,
  title: "something",
  why: "because",
  confidence: "medium",
  ...over,
} as Recommendation);

describe("stableId", () => {
  it("is deterministic across identical inputs", () => {
    const a = stableId({ file: "a.ts", startLine: 1, endLine: 2, kind: "bug" });
    const b = stableId({ file: "a.ts", startLine: 1, endLine: 2, kind: "bug" });
    expect(a).toBe(b);
  });

  it("differs when kind differs", () => {
    const a = stableId({ file: "a.ts", startLine: 1, endLine: 2, kind: "bug" });
    const b = stableId({ file: "a.ts", startLine: 1, endLine: 2, kind: "security" });
    expect(a).not.toBe(b);
  });

  it("differs when line range differs", () => {
    const a = stableId({ file: "a.ts", startLine: 1, endLine: 2, kind: "bug" });
    const b = stableId({ file: "a.ts", startLine: 1, endLine: 3, kind: "bug" });
    expect(a).not.toBe(b);
  });
});

describe("mergeSamples", () => {
  it("returns empty for zero samples", () => {
    expect(mergeSamples([])).toEqual([]);
  });

  it("merges identical findings across samples into one bucket with votes=N", () => {
    const r = rec({ title: "missing await" });
    const merged = mergeSamples([[r], [r], [r]]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.votes).toBe(3);
    expect(merged[0]!.totalSamples).toBe(3);
  });

  it("does not double-count a finding appearing twice within one sample", () => {
    const r = rec({});
    const merged = mergeSamples([[r, r], [r]]);
    expect(merged[0]!.votes).toBe(2);
  });

  it("separates different files", () => {
    const a = rec({ file: "a.ts" });
    const b = rec({ file: "b.ts" });
    const merged = mergeSamples([[a, b], [a]]);
    expect(merged).toHaveLength(2);
    const byFile = Object.fromEntries(merged.map((m) => [m.file, m.votes]));
    expect(byFile["a.ts"]).toBe(2);
    expect(byFile["b.ts"]).toBe(1);
  });

  it("sorts by votes desc then by severity", () => {
    const high = rec({ file: "hi.ts", severity: "high" });
    const low = rec({ file: "lo.ts", severity: "low" });
    const merged = mergeSamples([[high, low], [high], [low]]);
    expect(merged[0]!.file).toBe("hi.ts");
  });

  it("picks the longest why as canonical", () => {
    const short = rec({ why: "short" });
    const longer = rec({ why: "a much longer and more explanatory reasoning paragraph" });
    const merged = mergeSamples([[short], [longer]]);
    expect(merged[0]!.why).toContain("much longer");
    expect(merged[0]!.variants).toHaveLength(2);
  });
});
