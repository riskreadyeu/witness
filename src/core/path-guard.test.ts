/**
 * Tests for the repo-root containment guard.
 *
 * The headline case is the sibling-prefix escape that the old
 * `abs.startsWith(root)` check let through — and the in-repo symlink
 * escape it never canonicalized. Both must be rejected.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escapesRepoRoot, resolveSafePath } from "./path-guard.js";

let root: string;
let sibling: string;

beforeAll(() => {
  // realpathSync so macOS /var → /private/var symlinking doesn't confuse the
  // canonicalization re-check.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "witness-pg-")));
  root = join(base, "repo");
  sibling = join(base, "repo-secrets"); // shares the "repo" name prefix
  mkdirSync(root);
  mkdirSync(sibling);
  writeFileSync(join(root, "inside.ts"), "export const ok = 1;\n");
  writeFileSync(join(sibling, "secret.env"), "TOKEN=leak\n");
  // An in-repo symlink that points OUT of the repo.
  symlinkSync(join(sibling, "secret.env"), join(root, "evil-link"));
});

afterAll(() => {
  rmSync(join(root, ".."), { recursive: true, force: true });
});

describe("resolveSafePath", () => {
  it("resolves a legitimate in-repo relative path", () => {
    expect(resolveSafePath(root, "inside.ts")).toBe(join(root, "inside.ts"));
  });

  it("allows a not-yet-existing in-repo path (ENOENT passes syntactic check)", () => {
    expect(resolveSafePath(root, "not-created-yet.ts")).toBe(join(root, "not-created-yet.ts"));
  });

  it("rejects a parent-traversal path", () => {
    expect(() => resolveSafePath(root, "../secret.env")).toThrow(/escapes repoRoot/);
  });

  it("rejects a sibling-prefix absolute path (the startsWith bug)", () => {
    // /…/repo-secrets/secret.env passed the old `startsWith('/…/repo')` check.
    expect(() => resolveSafePath(root, join(sibling, "secret.env"))).toThrow(/escapes repoRoot/);
  });

  it("rejects an in-repo symlink that points outside the root", () => {
    expect(() => resolveSafePath(root, "evil-link")).toThrow(/escapes repoRoot via symlink/);
  });
});

describe("escapesRepoRoot", () => {
  it("is false for a contained path", () => {
    expect(escapesRepoRoot(root, join(root, "a/b.ts"))).toBe(false);
  });
  it("is true for a sibling-prefix path", () => {
    expect(escapesRepoRoot(root, join(sibling, "x"))).toBe(true);
  });
  it("is true for a parent path", () => {
    expect(escapesRepoRoot(root, join(root, ".."))).toBe(true);
  });
});
