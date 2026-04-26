/**
 * Diff ingestion.
 *
 * v0.1 strategy: ship the diff as the user message, and let the agent
 * use its Read / Grep / Glob tools to pull any additional context it
 * needs. The SDK runs those tools in a sandbox rooted at the repo we
 * pass as `cwd`, so we don't need to pre-bundle file contents.
 *
 * We still list the touched files in the message so the model has a
 * clear starting point — otherwise on a 500-line diff it spends turns
 * figuring out what even changed.
 */

import { readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

export interface DiffContext {
  diff: string;
  touchedFiles: string[];
  repoRoot: string;
}

export type PromptToolStyle = "claude" | "codex";

/**
 * Parse a unified diff and return the list of file paths that appear in
 * `+++ b/...` lines (post-change). We only care about the new side —
 * Witness reviews what the change WILL look like, not what was deleted.
 */
export function extractTouchedFiles(diff: string): string[] {
  const files: string[] = [];
  const lines = diff.split("\n");
  for (const line of lines) {
    if (!line.startsWith("+++ ")) continue;
    const match = line.match(/^\+\+\+ (?:b\/)?(.+?)(?:\s+\(.*\))?$/);
    if (!match) continue;
    const path = match[1];
    if (!path || path === "/dev/null") continue;
    files.push(path);
  }
  return [...new Set(files)];
}

export function buildContext(params: {
  diff: string;
  repoRoot: string;
}): DiffContext {
  return {
    diff: params.diff,
    touchedFiles: extractTouchedFiles(params.diff),
    repoRoot: params.repoRoot,
  };
}

/**
 * Render the diff into a user-message string.
 *
 * The model has Read/Grep/Glob rooted at `repoRoot`, so the prompt is
 * kept lean: the diff itself, a list of touched files, and the ask.
 */
export function renderUserMessage(ctx: DiffContext, toolStyle: PromptToolStyle = "claude"): string {
  const parts: string[] = [];

  parts.push("# Diff under review\n");
  parts.push("```diff\n" + ctx.diff.trimEnd() + "\n```\n");

  if (ctx.touchedFiles.length > 0) {
    parts.push("# Files touched (post-change paths)\n");
    for (const f of ctx.touchedFiles) parts.push(`- ${f}`);
    parts.push("");
  }

  if (toolStyle === "codex") {
    parts.push(
      "You are running in the Codex read-only sandbox. Use read-only " +
        "inspection commands to pull in whatever surrounding context you " +
        "need before producing findings: full file bodies, call sites, " +
        "adjacent tests, and related types. The diff alone is rarely enough.",
    );
  } else {
    parts.push(
      "You have Read, Grep, and Glob rooted at the repository. Use them " +
        "to pull in whatever surrounding context you need before producing " +
        "findings — the file's full body, call sites, adjacent tests, " +
        "related types. The diff alone is rarely enough.",
    );
  }
  parts.push("");
  parts.push(
    "Return a JSON object of shape `{ findings: Recommendation[] }`. " +
      "An empty `findings` array is a valid response.",
  );

  return parts.join("\n");
}

/**
 * Read the input named by --diff. Two modes:
 *
 *   `--diff -`           read from stdin (piped patch). No file path, so
 *                        nothing to traverse.
 *   `--diff <path>`      read from disk, but only if the canonical path
 *                        (post-symlink-resolution) sits inside repoRoot.
 *                        Two-stage check: first reject syntactic escapes
 *                        ("../" etc.), then realpath() the file and re-check
 *                        against the canonical repoRoot. Without the second
 *                        check, a repo-internal symlink (e.g. an attacker-
 *                        planted `repo/foo -> /etc/passwd`) would pass the
 *                        first check and then have its target read by
 *                        readFile, which silently follows symlinks.
 *
 * The agent's read tools are already sandboxed to repoRoot by the SDK /
 * codex CLI; this brings the wrapper's own input intake into line with
 * the same boundary the README sells.
 */
export async function readDiffInput(diffFile: string, repoRoot: string): Promise<string> {
  if (diffFile === "-") {
    if (process.stdin.isTTY) {
      throw new Error(
        "--diff - expects a patch on stdin, but stdin is a TTY.\n" +
          "Pipe a patch in: `git diff | witness --diff -`",
      );
    }
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf-8");
  }
  const root = resolve(repoRoot);
  const absolute = resolve(root, diffFile);
  if (escapesRepoRoot(root, absolute)) {
    throw outsideRepoError(diffFile, absolute, root);
  }
  // Canonicalize symlinks. realpath also throws ENOENT if the file is
  // missing, which is the right behavior — let it propagate.
  const realRoot = await realpath(root);
  const realAbsolute = await realpath(absolute);
  if (escapesRepoRoot(realRoot, realAbsolute)) {
    throw new Error(
      `--diff path "${diffFile}" is a symlink that escapes the repo root.\n` +
        `  symlink:   ${absolute}\n` +
        `  resolves:  ${realAbsolute}\n` +
        `  repo:      ${realRoot}\n\n` +
        `Witness refuses to follow symlinks out of the repository.`,
    );
  }
  return readFile(realAbsolute, "utf-8");
}

function escapesRepoRoot(root: string, absolute: string): boolean {
  const rel = relative(root, absolute);
  return rel === ".." || rel.startsWith(".." + sep);
}

function outsideRepoError(diffFile: string, absolute: string, root: string): Error {
  return new Error(
    `--diff path "${diffFile}" resolves outside the repo root.\n` +
      `  resolved: ${absolute}\n` +
      `  repo:     ${root}\n\n` +
      `Witness only reads patch files from inside the repo.\n` +
      `To feed an external patch, pipe it on stdin:\n` +
      `  cat /path/to/patch | witness --diff -`,
  );
}
