/**
 * Tests for the dissent layer.
 *
 * The persistence + lookup helpers need to behave well even when no review
 * has happened yet (loadLastReview returns null), and the prefix resolver
 * has three branches we care about: found, ambiguous, missing.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadLastReview,
  logDissent,
  persistLastReview,
  resolveFindingByIdPrefix,
} from "./dissent.js";
import type { VotedRecommendation } from "./schema.js";

function fakeFinding(id: string, overrides: Partial<VotedRecommendation> = {}): VotedRecommendation {
  return {
    id,
    kind: "bug",
    severity: "high",
    file: "src/x.ts",
    startLine: 1,
    endLine: 1,
    title: `finding ${id}`,
    why: "because",
    confidence: "high",
    votes: 3,
    totalSamples: 5,
    variants: [],
    ...overrides,
  };
}

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "witness-dissent-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("persistLastReview / loadLastReview", () => {
  it("returns null when no review has been persisted", async () => {
    expect(await loadLastReview(tmp)).toBeNull();
  });

  it("round-trips findings", async () => {
    const findings = [fakeFinding("aaaaaaaaaaaa"), fakeFinding("bbbbbbbbbbbb")];
    await persistLastReview(tmp, findings);
    const loaded = await loadLastReview(tmp);
    expect(loaded).not.toBeNull();
    expect(loaded!.findings).toHaveLength(2);
    expect(loaded!.findings[0]?.id).toBe("aaaaaaaaaaaa");
    expect(typeof loaded!.ts).toBe("string");
  });

  it("overwrites previous review on subsequent persist", async () => {
    await persistLastReview(tmp, [fakeFinding("aaaaaaaaaaaa")]);
    await persistLastReview(tmp, [fakeFinding("cccccccccccc")]);
    const loaded = await loadLastReview(tmp);
    expect(loaded!.findings).toHaveLength(1);
    expect(loaded!.findings[0]?.id).toBe("cccccccccccc");
  });
});

describe("resolveFindingByIdPrefix", () => {
  const findings = [
    fakeFinding("ab123456789a"),
    fakeFinding("ab123456789b"),
    fakeFinding("cd987654321a"),
  ];

  it("returns found for a unique prefix", () => {
    const r = resolveFindingByIdPrefix(findings, "cd9876");
    expect(r.kind).toBe("found");
    if (r.kind === "found") expect(r.finding.id).toBe("cd987654321a");
  });

  it("returns the full id when matched exactly", () => {
    const r = resolveFindingByIdPrefix(findings, "ab123456789a");
    expect(r.kind).toBe("found");
  });

  it("returns ambiguous when a prefix matches multiple findings", () => {
    const r = resolveFindingByIdPrefix(findings, "ab");
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") expect(r.matches).toHaveLength(2);
  });

  it("returns missing when nothing matches", () => {
    const r = resolveFindingByIdPrefix(findings, "zz");
    expect(r.kind).toBe("missing");
  });
});

describe("logDissent", () => {
  it("appends a JSONL line to .witness/dissent.jsonl", async () => {
    const rec = fakeFinding("ab123456789a");
    await logDissent({
      repoRoot: tmp,
      rec,
      action: "dismissed",
      note: "false positive — intentional",
    });
    await logDissent({ repoRoot: tmp, rec, action: "accepted" });

    const log = await readFile(join(tmp, ".witness", "dissent.jsonl"), "utf-8");
    const lines = log.trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    expect(first.action).toBe("dismissed");
    expect(first.note).toBe("false positive — intentional");
    expect(first.recommendation.id).toBe("ab123456789a");
    const second = JSON.parse(lines[1]!);
    expect(second.action).toBe("accepted");
    expect(second.note).toBeUndefined();
  });
});
