import { describe, expect, it } from "vitest";
import { renderUserMessage } from "./diff.js";

describe("renderUserMessage", () => {
  it("uses Codex-specific tool guidance when requested", () => {
    const out = renderUserMessage({
      diff: "diff --git a/a.ts b/a.ts\n+++ b/a.ts\n+ok",
      touchedFiles: ["a.ts"],
      repoRoot: "/repo",
    }, "codex");

    expect(out).toContain("Codex read-only sandbox");
    expect(out).not.toContain("Read, Grep, and Glob");
  });

  it("defaults to Claude tool guidance when no style is given", () => {
    const out = renderUserMessage({
      diff: "diff --git a/a.ts b/a.ts\n+++ b/a.ts\n+ok",
      touchedFiles: ["a.ts"],
      repoRoot: "/repo",
    });

    expect(out).toContain("Read, Grep, and Glob");
    expect(out).not.toContain("Codex read-only sandbox");
  });
});
