/**
 * Dissent logger — our feedback loop.
 *
 * Every time the user accepts or dismisses a recommendation, we append
 * a line to `.witness/dissent.jsonl` in the target repo (NOT in Witness's
 * own repo — the log lives with the code being reviewed).
 *
 * This is v0.1 telemetry for US, not for the user. It lets us see which
 * findings matter and which don't, so we can tune the system prompt and
 * system voting thresholds with signal instead of vibes.
 *
 * Never send this anywhere. It stays on the user's machine. The
 * gitignore ships with "dissent.jsonl" already excluded.
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { VotedRecommendation } from "./schema.js";

export type DissentAction = "accepted" | "dismissed" | "deferred";

export interface DissentEntry {
  ts: string;
  action: DissentAction;
  recommendation: {
    id: string;
    kind: VotedRecommendation["kind"];
    severity: VotedRecommendation["severity"];
    file: string;
    startLine: number;
    endLine: number;
    title: string;
    votes: number;
    totalSamples: number;
    confidence: VotedRecommendation["confidence"];
  };
  note?: string;
}

export async function logDissent(params: {
  repoRoot: string;
  rec: VotedRecommendation;
  action: DissentAction;
  note?: string;
}): Promise<void> {
  const { repoRoot, rec, action, note } = params;
  const logPath = join(repoRoot, ".witness", "dissent.jsonl");
  await mkdir(dirname(logPath), { recursive: true });

  const entry: DissentEntry = {
    ts: new Date().toISOString(),
    action,
    recommendation: {
      id: rec.id,
      kind: rec.kind,
      severity: rec.severity,
      file: rec.file,
      startLine: rec.startLine,
      endLine: rec.endLine,
      title: rec.title,
      votes: rec.votes,
      totalSamples: rec.totalSamples,
      confidence: rec.confidence,
    },
    ...(note !== undefined ? { note } : {}),
  };

  await appendFile(logPath, JSON.stringify(entry) + "\n", "utf-8");
}

/**
 * Persist the most recent review's findings so a later `witness dissent <id>`
 * invocation can look them up. Overwrites previous run — we only support
 * dissent against the most-recent review. Storing every historical run was
 * tempting but adds disk-cleanup obligations and a stale-IDs problem; the
 * single-slot model is honest about what `witness dissent` actually means.
 *
 * Lives at `<repoRoot>/.witness/last-review.json`. The .witness directory
 * is already gitignored.
 */
export interface LastReview {
  ts: string;
  findings: VotedRecommendation[];
}

export async function persistLastReview(
  repoRoot: string,
  findings: VotedRecommendation[],
): Promise<void> {
  const path = join(repoRoot, ".witness", "last-review.json");
  await mkdir(dirname(path), { recursive: true });
  const payload: LastReview = {
    ts: new Date().toISOString(),
    findings,
  };
  await writeFile(path, JSON.stringify(payload, null, 2), "utf-8");
}

export async function loadLastReview(repoRoot: string): Promise<LastReview | null> {
  const path = join(repoRoot, ".witness", "last-review.json");
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as LastReview;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/**
 * Resolve a user-supplied ID prefix against the last review's findings.
 * IDs are 12-char hex; users typing them are likely to copy a short
 * prefix. We accept any prefix that's unambiguous.
 */
export function resolveFindingByIdPrefix(
  findings: VotedRecommendation[],
  prefix: string,
): { kind: "found"; finding: VotedRecommendation }
  | { kind: "ambiguous"; matches: VotedRecommendation[] }
  | { kind: "missing" } {
  const matches = findings.filter((f) => f.id.startsWith(prefix));
  if (matches.length === 0) return { kind: "missing" };
  if (matches.length === 1) return { kind: "found", finding: matches[0]! };
  return { kind: "ambiguous", matches };
}
