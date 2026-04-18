/**
 * Dissent logger — our feedback loop.
 *
 * Every time the user accepts or dismisses a recommendation, we append
 * a line to `.oracle/dissent.jsonl` in the target repo (NOT in Oracle's
 * own repo — the log lives with the code being reviewed).
 *
 * This is v0.1 telemetry for US, not for the user. It lets us see which
 * findings matter and which don't, so we can tune the system prompt and
 * system voting thresholds with signal instead of vibes.
 *
 * Never send this anywhere. It stays on the user's machine. The
 * gitignore ships with "dissent.jsonl" already excluded.
 */

import { appendFile, mkdir } from "node:fs/promises";
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
  const logPath = join(repoRoot, ".oracle", "dissent.jsonl");
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
