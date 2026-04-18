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

export interface DiffContext {
  diff: string;
  touchedFiles: string[];
  repoRoot: string;
}

/**
 * Parse a unified diff and return the list of file paths that appear in
 * `+++ b/...` lines (post-change). We only care about the new side —
 * Oracle reviews what the change WILL look like, not what was deleted.
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
export function renderUserMessage(ctx: DiffContext): string {
  const parts: string[] = [];

  parts.push("# Diff under review\n");
  parts.push("```diff\n" + ctx.diff.trimEnd() + "\n```\n");

  if (ctx.touchedFiles.length > 0) {
    parts.push("# Files touched (post-change paths)\n");
    for (const f of ctx.touchedFiles) parts.push(`- ${f}`);
    parts.push("");
  }

  parts.push(
    "You have Read, Grep, and Glob rooted at the repository. Use them " +
      "to pull in whatever surrounding context you need before producing " +
      "findings — the file's full body, call sites, adjacent tests, " +
      "related types. The diff alone is rarely enough.",
  );
  parts.push("");
  parts.push(
    "Return a JSON object of shape `{ findings: Recommendation[] }`. " +
      "An empty `findings` array is a valid response.",
  );

  return parts.join("\n");
}
