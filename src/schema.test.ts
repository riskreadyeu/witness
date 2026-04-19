/**
 * Schema-level security tests.
 *
 * The `file` field on every Recommendation is the structural defense
 * against a hijacked agent (e.g., via prompt injection) emitting a
 * finding that escapes the repo root. These tests pin the rejection
 * surface so a regex tweak can't silently weaken it.
 */

import { describe, it, expect } from "vitest";
import { RecommendationSchema } from "./schema.js";

const validBase = {
  kind: "bug" as const,
  severity: "medium" as const,
  startLine: 1,
  endLine: 1,
  title: "ok",
  why: "ok",
  confidence: "medium" as const,
};

describe("RecommendationSchema file path containment", () => {
  it.each([
    ["src/user-service.ts"],
    ["packages/api/src/auth/session.ts"],
    ["a.ts"],
    ["dir/.hidden/file"],
    ["weird name with spaces.md"],
  ])("accepts safe repo-relative path: %s", (file) => {
    const result = RecommendationSchema.safeParse({ ...validBase, file });
    expect(result.success).toBe(true);
  });

  it.each([
    ["/etc/passwd"],
    ["/home/daniel/.claude/.credentials.json"],
    ["~/.ssh/id_rsa"],
    ["~"],
    ["../../etc/passwd"],
    ["src/../../../secret"],
    ["a/b/../../../escape"],
    ["C:\\Windows\\System32\\config\\SAM"],
    ["c:/users/whatever"],
    ["src/file\0.ts"],
  ])("rejects dangerous path: %s", (file) => {
    const result = RecommendationSchema.safeParse({ ...validBase, file });
    expect(result.success).toBe(false);
  });
});
