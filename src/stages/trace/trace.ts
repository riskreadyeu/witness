/**
 * Trace stage orchestration.
 *
 * Pure-stats path today (no LLM calls; deterministic; zero API cost).
 * Reads a JSONL file or stdin, parses events, computes stats, derives
 * findings. LLM-based qualitative review on top of flagged events is a
 * v0.4 add — the stats path already surfaces the structural failure
 * modes the LexAi/data/usage/*.jsonl format can ground.
 */

import type { Finding, TraceEvent } from "./schema.js";
import { readTraceFile, readTraceStdin } from "./reader.js";
import { computeStats, type TraceStats } from "./stats.js";
import { deriveFindings, type FindingsOptions } from "./findings.js";

export interface TraceReviewOptions extends FindingsOptions {
  /** Path to a JSONL file. If undefined, reads from stdin. */
  path?: string;
}

export interface TraceReviewResult {
  findings: Finding[];
  stats: TraceStats;
  raw: {
    events: TraceEvent[];
    skipped: number;
    skippedReasons: string[];
  };
  meta: {
    source: string;
    elapsedMs: number;
    apiCalls: number;
    totalCostUsd: number;
  };
}

export async function review(opts: TraceReviewOptions): Promise<TraceReviewResult> {
  const started = Date.now();
  const source = opts.path ?? "stdin";
  const read = opts.path
    ? await readTraceFile(opts.path)
    : await readTraceStdin();

  const stats = computeStats(read.events);
  const findings = deriveFindings(read.events, stats, opts);

  return {
    findings,
    stats,
    raw: {
      events: read.events,
      skipped: read.skipped,
      skippedReasons: read.skippedReasons,
    },
    meta: {
      source,
      elapsedMs: Date.now() - started,
      apiCalls: 0,
      totalCostUsd: 0,
    },
  };
}
