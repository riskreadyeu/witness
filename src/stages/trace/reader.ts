/**
 * JSONL reader for trace events.
 *
 * Accepts both LexAi event shapes (codex-cli and Claude SDK). Requires
 * only the fields every shape carries: emitted_at, model, query, is_error,
 * subtype. Optional fields (session_id, num_turns, duration_ms, etc.)
 * flow through as-is; downstream stats/findings handle missing values.
 */

import { readFile } from "node:fs/promises";
import type { TraceEvent } from "./schema.js";

const REQUIRED_KEYS: ReadonlyArray<keyof TraceEvent> = [
  "emitted_at",
  "model",
  "query",
  "is_error",
  "subtype",
];

export interface ReadResult {
  events: TraceEvent[];
  skipped: number;
  skippedReasons: string[];
}

export async function readTraceFile(path: string): Promise<ReadResult> {
  const raw = await readFile(path, "utf8");
  return parseJsonl(raw);
}

export async function readTraceStdin(): Promise<ReadResult> {
  let buf = "";
  for await (const chunk of process.stdin) {
    buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  }
  return parseJsonl(buf);
}

export function parseJsonl(raw: string): ReadResult {
  const events: TraceEvent[] = [];
  const skippedReasons: string[] = [];
  let skipped = 0;
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      skipped++;
      if (skippedReasons.length < 5) {
        skippedReasons.push(`line ${i + 1}: ${(err as Error).message.slice(0, 80)}`);
      }
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) {
      skipped++;
      continue;
    }
    const obj = parsed as Record<string, unknown>;
    const missing = REQUIRED_KEYS.filter((k) => !(k in obj));
    if (missing.length > 0) {
      skipped++;
      if (skippedReasons.length < 5) {
        skippedReasons.push(`line ${i + 1}: missing required fields ${missing.join(",")}`);
      }
      continue;
    }
    events.push(obj as unknown as TraceEvent);
  }
  return { events, skipped, skippedReasons };
}
