import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readDiffInput, renderUserMessage } from "./diff.js";

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

describe("readDiffInput", () => {
  it("reads a patch file inside the repo root", async () => {
    const root = await mkdtemp(join(tmpdir(), "witness-diff-in-"));
    try {
      const patchPath = join(root, "feature.patch");
      await writeFile(patchPath, "diff --git a/x b/x\n+++ b/x\n+ok\n", "utf-8");
      const out = await readDiffInput(patchPath, root);
      expect(out).toContain("+++ b/x");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads a patch via a relative subpath", async () => {
    const root = await mkdtemp(join(tmpdir(), "witness-diff-rel-"));
    try {
      const subdir = join(root, "patches");
      await mkdir(subdir);
      const patchPath = join(subdir, "x.patch");
      await writeFile(patchPath, "diff --git a/x b/x\n+++ b/x\n+ok\n", "utf-8");
      const out = await readDiffInput("patches/x.patch", root);
      expect(out).toContain("+++ b/x");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses an absolute path outside the repo root", async () => {
    const root = await mkdtemp(join(tmpdir(), "witness-diff-abs-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "witness-outside-"));
    try {
      const outside = join(outsideDir, "secret.patch");
      await writeFile(outside, "any content", "utf-8");
      await expect(readDiffInput(outside, root)).rejects.toThrow(
        /resolves outside the repo root/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("refuses a relative path that escapes via ..", async () => {
    const root = await mkdtemp(join(tmpdir(), "witness-diff-dotdot-"));
    try {
      await expect(readDiffInput("../../etc/passwd", root)).rejects.toThrow(
        /resolves outside the repo root/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a symlink that points outside the repo root", async () => {
    const root = await mkdtemp(join(tmpdir(), "witness-diff-symlink-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "witness-symlink-target-"));
    try {
      const target = join(outsideDir, "secret.patch");
      await writeFile(target, "should not be read", "utf-8");
      const linkPath = join(root, "innocent-looking.patch");
      await symlink(target, linkPath);
      await expect(readDiffInput(linkPath, root)).rejects.toThrow(
        /symlink that escapes the repo root/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("allows a symlink that points to another file inside the repo", async () => {
    const root = await mkdtemp(join(tmpdir(), "witness-diff-symlink-ok-"));
    try {
      const real = join(root, "real.patch");
      await writeFile(real, "diff --git a/x b/x\n+++ b/x\n+inside\n", "utf-8");
      const linkPath = join(root, "alias.patch");
      await symlink(real, linkPath);
      const out = await readDiffInput(linkPath, root);
      expect(out).toContain("+inside");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
