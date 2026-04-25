/**
 * Terminal rendering for Witness findings.
 *
 * ANSI-light; we do just enough color to make severity visually legible
 * without dragging in a dependency. `NO_COLOR` disables all escapes per
 * the no-color.org convention.
 */

import type { VotedRecommendation } from "./schema.js";
import type { ParseError } from "./witness.js";
import type { BackendKind } from "./backend.js";

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
  model: string | null;
  samplesRequested: number;
  samplesParsed: number;
  elapsedMs: number;
  backend?: BackendKind | "custom";
}): string {
  const lines: string[] = [];
  const modelLabel = formatModelLabel(meta.model, meta.backend);

  if (findings.length === 0) {
    lines.push(c.dim("Witness has no findings."));
    lines.push(
      c.gray(
        `  ${meta.samplesParsed}/${meta.samplesRequested} samples parsed · ${modelLabel} · ${Math.round(meta.elapsedMs / 100) / 10}s`,
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
      `  ${findings.length} finding${findings.length === 1 ? "" : "s"} · ${meta.samplesParsed}/${meta.samplesRequested} samples · ${modelLabel} · ${Math.round(meta.elapsedMs / 100) / 10}s`,
    ),
  );

  return lines.join("\n");
}

/**
 * Build a human-readable model label. The codex backend doesn't always
 * resolve to a known model id from our side — when the user hasn't passed
 * `--model`, codex picks from its own config and we have no honest way
 * to label it. Don't lie; say so.
 */
function formatModelLabel(model: string | null, backend?: BackendKind | "custom"): string {
  if (model) return model;
  if (backend === "codex") return "codex (config default)";
  return "model unspecified";
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
  backend?: BackendKind | "custom";
}): string {
  const kinds = new Map<FailureKind, number>();
  for (const e of input.parseErrors) {
    // Classify against both fields. SDK exceptions land as
    // error="sample failed" with the actual cause in `detail`.
    const kind = classifyError(`${e.error} ${e.detail ?? ""}`);
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }

  const lines: string[] = [];
  lines.push(
    c.red(c.bold(`witness: all ${input.samplesRequested} samples failed — no review produced.`)),
  );
  lines.push("");
  // Codex backend doesn't expose per-sample cost or turn counts to us, so
  // showing $0.0000 / 0 turns is misleading — say so explicitly instead of
  // pretending we measured zero.
  if (input.backend === "codex") {
    lines.push(
      c.gray(
        `ran in ${(input.elapsedMs / 1000).toFixed(1)}s (codex backend; cost and turns not tracked).`,
      ),
    );
  } else {
    lines.push(
      c.gray(
        `spent $${input.totalCostUsd.toFixed(4)} over ${input.totalTurns} turns in ${(input.elapsedMs / 1000).toFixed(1)}s.`,
      ),
    );
  }
  lines.push("");
  lines.push("failure breakdown:");
  for (const [kind, n] of kinds) {
    lines.push(`  ${n}× ${kind}`);
  }
  lines.push("");
  lines.push("first errors:");
  for (const e of input.parseErrors.slice(0, 3)) {
    const tail = e.detail ? ` — ${truncate(firstLine(e.detail), 240)}` : "";
    lines.push(c.gray(`  sample ${e.sampleIndex}: ${e.error}${tail}`));
  }
  lines.push("");
  lines.push("suggestions:");
  if (kinds.has("codex missing")) {
    lines.push(`  - the ${c.bold("codex")} CLI was not found on PATH. Install it:`);
    lines.push(`      ${c.bold("npm install -g @openai/codex")}`);
  }
  if (kinds.has("codex auth")) {
    lines.push(`  - codex is not authenticated. Run:`);
    lines.push(`      ${c.bold("codex login")}`);
  }
  if (kinds.has("auth")) {
    lines.push(`  - missing or invalid Claude credentials. Either:`);
    lines.push(`      ${c.bold("claude login")}                   (uses Pro/Max subscription), or`);
    lines.push(`      ${c.bold("export ANTHROPIC_API_KEY=sk-…")}  (uses an API key)`);
  }
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
  | "auth"
  | "codex missing"
  | "codex auth"
  | "budget exhausted"
  | "turns exhausted"
  | "json validation failed"
  | "unknown";

export function classifyError(raw: string): FailureKind {
  if (/error_max_budget_usd/.test(raw)) return "budget exhausted";
  if (/error_max_turns/.test(raw)) return "turns exhausted";
  if (/json validation failed/i.test(raw)) return "json validation failed";
  if (/spawn codex|codex.*ENOENT|ENOENT.*codex/i.test(raw)) return "codex missing";
  if (/codex.*not.*authenticated|codex login|not signed in/i.test(raw)) return "codex auth";
  if (/ANTHROPIC_API_KEY|claude login|invalid_api_key|\b401\b|unauthorized|authentication/i.test(raw)) {
    return "auth";
  }
  return "unknown";
}

function firstLine(s: string): string {
  const i = s.indexOf("\n");
  return i === -1 ? s : s.slice(0, i);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
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
