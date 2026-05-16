/**
 * Statistical summaries over a TraceEvent[] corpus.
 *
 * Tolerates events that lack cost/duration/turn fields (codex-cli shape).
 * Each Quantile reports a `count` reflecting how many events had the
 * field — if `count == 0`, downstream findings should not emit
 * comparisons against that quantile.
 */

import type { TraceEvent } from "./schema.js";

export interface Quantile {
  count: number;
  median: number;
  p95: number;
  p99: number;
  mean: number;
  max: number;
}

export interface TraceStats {
  total: number;
  errors: number;
  errorRate: number;
  cost: Quantile;
  duration: Quantile;
  turns: Quantile;
  modelCounts: Record<string, number>;
  subtypeCounts: Record<string, number>;
  queryCounts: Record<string, number>;
}

export function computeStats(events: TraceEvent[]): TraceStats {
  const costs = pluckDefined(events, "total_cost_usd");
  const durations = pluckDefined(events, "duration_ms");
  const turns = pluckDefined(events, "num_turns");
  const errors = events.filter((e) => e.is_error === true).length;

  const modelCounts: Record<string, number> = {};
  const subtypeCounts: Record<string, number> = {};
  const queryCounts: Record<string, number> = {};
  for (const e of events) {
    modelCounts[e.model] = (modelCounts[e.model] ?? 0) + 1;
    subtypeCounts[e.subtype] = (subtypeCounts[e.subtype] ?? 0) + 1;
    const q = normalizeQuery(e.query);
    queryCounts[q] = (queryCounts[q] ?? 0) + 1;
  }

  return {
    total: events.length,
    errors,
    errorRate: events.length === 0 ? 0 : errors / events.length,
    cost: quantile(costs),
    duration: quantile(durations),
    turns: quantile(turns),
    modelCounts,
    subtypeCounts,
    queryCounts,
  };
}

export function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

function pluckDefined(events: TraceEvent[], key: "total_cost_usd" | "duration_ms" | "num_turns"): number[] {
  const out: number[] = [];
  for (const e of events) {
    const v = e[key];
    if (typeof v === "number" && Number.isFinite(v)) out.push(v);
  }
  return out;
}

export function quantile(values: number[]): Quantile {
  if (values.length === 0) {
    return { count: 0, median: 0, p95: 0, p99: 0, mean: 0, max: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    median: pick(sorted, 0.5),
    p95: pick(sorted, 0.95),
    p99: pick(sorted, 0.99),
    mean: sum / sorted.length,
    max: sorted[sorted.length - 1]!,
  };
}

function pick(sorted: number[], frac: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor(frac * sorted.length));
  return sorted[idx]!;
}
