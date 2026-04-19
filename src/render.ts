/**
 * Terminal rendering for Witness findings.
 *
 * ANSI-light; we do just enough color to make severity visually legible
 * without dragging in a dependency. `NO_COLOR` disables all escapes per
 * the no-color.org convention.
 */

import type { VotedRecommendation } from "./schema.js";
import type { ParseError } from "./witness.js";

const useColor = !process.env.NO_COLOR && process.stdout.isTTY;

const c = {
  dim:    wrap("\x1b[2m",  "\x1b[22m"),
  bold:   wrap("\x1b[1m",  "\x1b[22m"),
  red:    wrap("\x1b[31m", "\x1b[39m"),
  yellow: wrap("\x1b[33m", "\x1b[39m"),
  blue:   wrap("\x1b[34m", "\x1b[39m"),
  gray:   wrap("\x1b[90m", "\x1b[39m"),
};

function wrap(open: string, close: string) {
  return (s: string) => (useColor ? `${open}${s}${close}` : s);
}

export function renderFindings(findings: VotedRecommendation[], meta: {
  model: string;
  samplesRequested: number;
  samplesParsed: number;
  elapsedMs: number;
}): string {
  const lines: string[] = [];

  if (findings.length === 0) {
    lines.push(c.dim("Witness has no findings."));
    lines.push(
      c.gray(
        `  ${meta.samplesParsed}/${meta.samplesRequested} samples parsed · ${meta.model} · ${Math.round(meta.elapsedMs / 100) / 10}s`,
      ),
    );
    return lines.join("\n");
  }

  for (const f of findings) {
    lines.push("");
    lines.push(
      `${severityBadge(f.severity)} ${c.bold(f.title)}`,
    );
    lines.push(
      c.gray(
        `  ${f.kind} · ${f.file}:${f.startLine}${f.endLine !== f.startLine ? `-${f.endLine}` : ""} · ${f.votes}/${f.totalSamples} votes · ${f.confidence} confidence`,
      ),
    );
    const wrapped = wrapParagraph(f.why, 76);
    for (const wl of wrapped) lines.push("  " + wl);
  }

  lines.push("");
  lines.push(
    c.gray(
      `  ${findings.length} finding${findings.length === 1 ? "" : "s"} · ${meta.samplesParsed}/${meta.samplesRequested} samples · ${meta.model} · ${Math.round(meta.elapsedMs / 100) / 10}s`,
    ),
  );

  return lines.join("\n");
}

function severityBadge(s: VotedRecommendation["severity"]): string {
  switch (s) {
    case "critical": return c.red(c.bold("[CRITICAL]"));
    case "high":     return c.red("[HIGH]    ");
    case "medium":   return c.yellow("[MEDIUM]  ");
    case "low":      return c.blue("[LOW]     ");
  }
}

/**
 * Render the "every sample failed" scenario. This is its own path because
 * `renderFindings` with zero findings means "Witness found nothing wrong",
 * which is actively misleading when the truth is "Witness couldn't produce
 * any findings at all". The caller should also exit non-zero.
 */
export function renderTotalFailure(input: {
  samplesRequested: number;
  totalTurns: number;
  totalCostUsd: number;
  elapsedMs: number;
  parseErrors: ParseError[];
}): string {
  const kinds = new Map<FailureKind, number>();
  for (const e of input.parseErrors) {
    const kind = classifyError(e.error);
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }

  const lines: string[] = [];
  lines.push(
    c.red(c.bold(`witness: all ${input.samplesRequested} samples failed — no review produced.`)),
  );
  lines.push("");
  lines.push(
    c.gray(
      `spent $${input.totalCostUsd.toFixed(4)} over ${input.totalTurns} turns in ${(input.elapsedMs / 1000).toFixed(1)}s.`,
    ),
  );
  lines.push("");
  lines.push("failure breakdown:");
  for (const [kind, n] of kinds) {
    lines.push(`  ${n}× ${kind}`);
  }
  lines.push("");
  lines.push("first errors:");
  for (const e of input.parseErrors.slice(0, 3)) {
    lines.push(c.gray(`  sample ${e.sampleIndex}: ${e.error}`));
  }
  lines.push("");
  lines.push("suggestions:");
  if (kinds.has("budget exhausted")) {
    lines.push(`  - raise per-sample budget:  ${c.bold("witness --budget 2.0 …")}`);
  }
  if (kinds.has("turns exhausted")) {
    lines.push(`  - raise turn cap:           ${c.bold("witness --max-turns 80 …")}`);
    lines.push(`  - or narrow the diff       (fewer / smaller files review faster)`);
  }
  if (kinds.has("json validation failed")) {
    lines.push(`  - the model produced non-schema output; rerun to retry`);
  }
  if (kinds.has("unknown") && kinds.size === 1) {
    lines.push(`  - inspect raw errors above; rerun with --json for the full record`);
  }
  return lines.join("\n");
}

type FailureKind =
  | "budget exhausted"
  | "turns exhausted"
  | "json validation failed"
  | "unknown";

export function classifyError(raw: string): FailureKind {
  if (/error_max_budget_usd/.test(raw)) return "budget exhausted";
  if (/error_max_turns/.test(raw)) return "turns exhausted";
  if (/json validation failed/i.test(raw)) return "json validation failed";
  return "unknown";
}

function wrapParagraph(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    if (current.length === 0) {
      current = w;
    } else if (current.length + 1 + w.length <= width) {
      current += " " + w;
    } else {
      lines.push(current);
      current = w;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}
