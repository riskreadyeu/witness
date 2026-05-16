/**
 * Findings derivation: TraceEvent[] + TraceStats → Finding[].
 *
 * Guards every cost/duration/turn comparison against the event having
 * that field (stats.cost.count etc.) — so codex-cli events without
 * cost data don't yield false flags.
 *
 * Thresholds are honest defaults, tunable via FindingsOptions so the
 * dissent log can re-calibrate over time.
 */

import type { TraceEvent, Finding } from "./schema.js";
import type { TraceStats } from "./stats.js";
import { normalizeQuery } from "./stats.js";

export interface FindingsOptions {
  /** Multiplier over median for cost/latency/turns to flag as outlier. */
  outlierFactor?: number;
  /** Minimum repetitions of the same normalized query to flag repeated-query. */
  repeatedQueryThreshold?: number;
  /** Minimum error rate to surface error-pattern. */
  errorRateThreshold?: number;
}

export function deriveFindings(
  events: TraceEvent[],
  stats: TraceStats,
  options: FindingsOptions = {},
): Finding[] {
  const k = options.outlierFactor ?? 5;
  const repeatN = options.repeatedQueryThreshold ?? 5;
  const errThresh = options.errorRateThreshold ?? 0.05;

  const findings: Finding[] = [];

  // cost-outlier — only over events that have total_cost_usd
  if (stats.cost.count > 0 && stats.cost.median > 0) {
    for (const e of events) {
      const cost = e.total_cost_usd;
      if (typeof cost !== "number" || !Number.isFinite(cost)) continue;
      if (cost >= stats.cost.median * k) {
        findings.push({
          kind: "cost-outlier",
          severity: cost >= stats.cost.median * 10 ? "high" : "medium",
          eventCount: 1,
          sessionIds: e.session_id ? [e.session_id] : [],
          title: `Single call cost $${cost.toFixed(4)} (${(cost / stats.cost.median).toFixed(1)}× median)`,
          why:
            `Median cost across ${stats.cost.count} cost-tracked traces is $${stats.cost.median.toFixed(4)}. ` +
            `This call charged $${cost.toFixed(4)} on model '${e.model}' for query '${e.query.slice(0, 80)}'. ` +
            `Cache-creation tokens often drive these spikes; check usage.cache_creation_input_tokens for this session.`,
          confidence: "high",
          evidence: {
            observedUsd: cost,
            medianUsd: stats.cost.median,
            ratio: cost / stats.cost.median,
            model: e.model,
          },
        });
      }
    }
  }

  // latency-spike — only over events that have duration_ms
  if (stats.duration.count > 0 && stats.duration.median > 0) {
    for (const e of events) {
      const dur = e.duration_ms;
      if (typeof dur !== "number" || !Number.isFinite(dur)) continue;
      if (dur >= stats.duration.median * k) {
        findings.push({
          kind: "latency-spike",
          severity: dur >= stats.duration.median * 10 ? "high" : "medium",
          eventCount: 1,
          sessionIds: e.session_id ? [e.session_id] : [],
          title: `Call took ${(dur / 1000).toFixed(1)}s (${(dur / stats.duration.median).toFixed(1)}× median)`,
          why:
            `Median duration across ${stats.duration.count} timed traces is ${(stats.duration.median / 1000).toFixed(1)}s. ` +
            `This call took ${(dur / 1000).toFixed(1)}s on model '${e.model}'. ` +
            `Long durations often correlate with high num_turns (this call: ${e.num_turns ?? "?"}). ` +
            `User experience suffers above ~10s.`,
          confidence: "high",
          evidence: {
            observedMs: dur,
            medianMs: stats.duration.median,
            ratio: dur / stats.duration.median,
            turns: e.num_turns,
          },
        });
      }
    }
  }

  // excessive-turns — only over events that have num_turns
  if (stats.turns.count > 0 && stats.turns.median > 0) {
    for (const e of events) {
      const t = e.num_turns;
      if (typeof t !== "number" || !Number.isFinite(t)) continue;
      if (t >= Math.max(stats.turns.median * k, 10)) {
        findings.push({
          kind: "excessive-turns",
          severity: t >= 20 ? "high" : "medium",
          eventCount: 1,
          sessionIds: e.session_id ? [e.session_id] : [],
          title: `Call used ${t} turns (median ${stats.turns.median})`,
          why:
            `Median turn count across ${stats.turns.count} turn-tracked traces is ${stats.turns.median}. ` +
            `This call ran ${t} turns — often a sign the model entered a tool loop, ` +
            `kept retrying after partial failures, or the system prompt led it down an exploratory path. ` +
            `Query was: '${e.query.slice(0, 120)}'.`,
          confidence: "medium",
          evidence: {
            observedTurns: t,
            medianTurns: stats.turns.median,
          },
        });
      }
    }
  }

  // error-pattern (corpus-level) — independent of optional fields
  if (stats.errorRate >= errThresh && stats.errors >= 3) {
    const erroredSessions = events
      .filter((e) => e.is_error === true)
      .slice(0, 10)
      .map((e) => e.session_id ?? `(no-session)`);
    findings.push({
      kind: "error-pattern",
      severity: stats.errorRate >= 0.2 ? "critical" : stats.errorRate >= 0.1 ? "high" : "medium",
      eventCount: stats.errors,
      sessionIds: erroredSessions,
      title: `${stats.errors}/${stats.total} calls errored (${(stats.errorRate * 100).toFixed(1)}% error rate)`,
      why:
        `Across ${stats.total} traces, ${stats.errors} were errors or non-success subtypes. ` +
        `Subtype breakdown: ${Object.entries(stats.subtypeCounts).map(([s, n]) => `${s}=${n}`).join(", ")}. ` +
        `An error rate above ${(errThresh * 100).toFixed(0)}% deserves a root-cause pass.`,
      confidence: "high",
      evidence: {
        errorCount: stats.errors,
        totalCount: stats.total,
        errorRate: stats.errorRate,
        subtypes: stats.subtypeCounts,
      },
    });
  }

  // repeated-query
  for (const [q, n] of Object.entries(stats.queryCounts)) {
    if (n >= repeatN) {
      const sessions = events
        .filter((e) => normalizeQuery(e.query) === q)
        .slice(0, 10)
        .map((e) => e.session_id ?? `(no-session)`);
      findings.push({
        kind: "repeated-query",
        severity: n >= 20 ? "medium" : "low",
        eventCount: n,
        sessionIds: sessions,
        title: `Same query asked ${n} times across the trace`,
        why:
          `The normalized query '${q.slice(0, 100)}' appears ${n} times. ` +
          `Possible causes: identical user retrying a broken response, missing client-side caching, ` +
          `or N users hitting the same FAQ that should be cached or pre-computed. ` +
          `Inspect the response variance across these ${n} calls.`,
        confidence: "medium",
        evidence: { query: q, occurrences: n },
      });
    }
  }

  // model-drift (corpus-level) — independent of optional fields
  const modelEntries = Object.entries(stats.modelCounts);
  if (modelEntries.length >= 2) {
    const total = stats.total;
    const distribution = modelEntries
      .map(([m, n]) => `${m}=${n} (${((n / total) * 100).toFixed(0)}%)`)
      .join(", ");
    findings.push({
      kind: "model-drift",
      severity: modelEntries.length >= 3 ? "medium" : "low",
      eventCount: total,
      sessionIds: [],
      title: `${modelEntries.length} different models served traffic`,
      why:
        `Distribution: ${distribution}. ` +
        `If the app is supposed to serve one model, this is unexpected. ` +
        `If it intentionally A/B-tests or splits between backends (e.g., Claude SDK + codex-cli), confirm assignment is intentional and observable per session. ` +
        `Cost, latency, and quality differ across models — surfacing this so it's a choice, not a leak.`,
      confidence: "high",
      evidence: { modelCounts: stats.modelCounts },
    });
  }

  return findings;
}
