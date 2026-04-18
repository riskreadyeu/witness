/**
 * Terminal rendering for Oracle findings.
 *
 * ANSI-light; we do just enough color to make severity visually legible
 * without dragging in a dependency. `NO_COLOR` disables all escapes per
 * the no-color.org convention.
 */

import type { VotedRecommendation } from "./schema.js";

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
    lines.push(c.dim("Oracle has no findings."));
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
