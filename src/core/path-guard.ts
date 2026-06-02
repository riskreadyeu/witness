/**
 * Repo-root containment guard — single source of truth.
 *
 * Witness's read-only tools (Read/Grep/Glob in the direct + gemini runners,
 * and the --diff intake) must never resolve a path outside the repo root.
 *
 * The diff stage solved this correctly (relative()-based containment plus
 * realpath canonicalization); the direct and gemini runners shipped a weaker
 * `abs.startsWith(root)` check that had two bypasses:
 *
 *   1. Sibling-prefix escape: root has no trailing separator, so
 *      "/repo-secrets/.env" satisfies startsWith("/repo").
 *   2. No symlink canonicalization: an in-repo symlink pointing outside the
 *      root resolved to an in-root `abs` that passed startsWith, then
 *      readFile followed the link out.
 *
 * This module collapses all three call sites onto the correct implementation.
 */

import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * True when `absolute` is not contained within `root`. Uses relative() so a
 * sibling directory sharing a name prefix (the startsWith bug) is rejected.
 */
export function escapesRepoRoot(root: string, absolute: string): boolean {
  const rel = relative(root, absolute);
  return rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel);
}

/**
 * Resolve `p` (relative to repoRoot, or absolute) to a canonical absolute
 * path guaranteed to sit inside repoRoot. Two stages:
 *   1. Syntactic containment on the resolved path (catches "../" and
 *      sibling-prefix escapes).
 *   2. Symlink canonicalization via realpath, re-checked against the
 *      canonical root (catches in-repo symlinks that point outside).
 *
 * If the path does not exist yet (ENOENT), the syntactic check has already
 * passed and the resolved path is returned — realpath can't canonicalize a
 * file that isn't there, and refusing it would break legitimate reads of
 * not-yet-created paths.
 *
 * Throws if the path escapes the root by either route.
 */
export function resolveSafePath(repoRoot: string, p: string): string {
  const root = resolve(repoRoot);
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p);
  if (escapesRepoRoot(root, abs)) {
    throw new Error(`path escapes repoRoot: ${p}`);
  }
  try {
    const realRoot = realpathSync(root);
    const realAbs = realpathSync(abs);
    if (escapesRepoRoot(realRoot, realAbs)) {
      throw new Error(`path escapes repoRoot via symlink: ${p}`);
    }
    return realAbs;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return abs;
    throw e;
  }
}
