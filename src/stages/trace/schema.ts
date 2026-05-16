/**
 * Schema for trace-stage findings.
 *
 * Six finding kinds, derived statistically from the event log fields
 * actually present in LexAi/data/usage/*.jsonl. Two real shapes observed:
 *
 *   Shape A — codex-cli backend events (model, query, usage; NO session_id,
 *     duration_ms, num_turns, total_cost_usd)
 *   Shape B — Claude Agent SDK events (full schema with session_id,
 *     duration_ms, num_turns, total_cost_usd)
 *
 * TraceEvent treats the SDK-specific fields as optional so the reader
 * accepts both. Stats and findings skip events that lack the field they
 * need (e.g., no latency finding for an event without duration_ms).
 *
 * Resist expanding the union until a real trace log proves the existing
 * six don't cover a real failure mode.
 */

import { z } from "zod";

const Severity = z.enum(["critical", "high", "medium", "low"]);
const Confidence = z.enum(["high", "medium", "low"]);

const Base = z.object({
  severity: Severity,
  /** Number of events from the trace this finding aggregates. >= 1. */
  eventCount: z.number().int().positive(),
  /**
   * Session ids the finding touches (deduplicated). Empty = the finding
   * is a corpus-level pattern or the event lacked a session_id.
   */
  sessionIds: z.array(z.string()).default([]),
  title: z.string().min(1).max(200),
  why: z.string().min(1),
  confidence: Confidence,
  /** Numeric evidence: e.g., observed value, threshold, ratio. Free shape. */
  evidence: z.record(z.string(), z.unknown()).default({}),
});

export const FindingSchema = z.discriminatedUnion("kind", [
  Base.extend({ kind: z.literal("cost-outlier") }),
  Base.extend({ kind: z.literal("latency-spike") }),
  Base.extend({ kind: z.literal("excessive-turns") }),
  Base.extend({ kind: z.literal("error-pattern") }),
  Base.extend({ kind: z.literal("repeated-query") }),
  Base.extend({ kind: z.literal("model-drift") }),
]);

export type Finding = z.infer<typeof FindingSchema>;
export type FindingKind = Finding["kind"];
export const FindingsArraySchema = z.array(FindingSchema);

export interface TraceEvent {
  /** Required: every shape has these. */
  emitted_at: string;
  model: string;
  query: string;
  is_error: boolean;
  subtype: string;

  /** Optional: present on Claude Agent SDK events, absent on codex-cli events. */
  session_id?: string;
  num_turns?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  total_cost_usd?: number;

  /** Token usage shape varies; both backends provide some form of usage. */
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    service_tier?: string;
    [k: string]: unknown;
  };
}
