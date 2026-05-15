/**
 * Multi-sample voting.
 *
 * Stable id from (line, kind). We don't hash `why` — the model rephrases
 * the same concern every sample, so hashing prose would split votes.
 *
 * Edge case: two distinct findings on the same line with the same kind
 * (e.g., two ambiguities on line 42 referring to different phrases) will
 * collide. We accept that for v0.1 — it's rare, and the merged finding
 * will carry both `why` strings as variants. If it becomes a real
 * problem in evals, we can hash a normalized title prefix into the id.
 */

import { createHash } from "node:crypto";
import type { Finding, VotedFinding } from "./schema.js";

export function stableId(f: Pick<Finding, "line" | "kind">): string {
  const key = `${f.line}:${f.kind}`;
  return createHash("sha1").update(key).digest("hex").slice(0, 12);
}

/**
 * Merge findings from N independent samples into voted findings.
 */
export function mergeSamples(samples: Finding[][]): VotedFinding[] {
  const totalSamples = samples.length;
  const buckets = new Map<string, Finding[]>();

  for (const sample of samples) {
    const seenInSample = new Set<string>();
    for (const f of sample) {
      const id = stableId(f);
      if (seenInSample.has(id)) continue;
      seenInSample.add(id);
      const existing = buckets.get(id);
      if (existing) existing.push(f);
      else buckets.set(id, [f]);
    }
  }

  const merged: VotedFinding[] = [];
  for (const [id, variants] of buckets) {
    const canonical = pickCanonical(variants);
    merged.push({
      id,
      kind: canonical.kind,
      severity: canonical.severity,
      line: canonical.line,
      title: canonical.title,
      why: canonical.why,
      confidence: canonical.confidence,
      votes: variants.length,
      totalSamples,
      variants,
    });
  }

  // Sort: votes desc, then severity (critical first), then line asc.
  const sevRank: Record<Finding["severity"], number> = {
    critical: 0, high: 1, medium: 2, low: 3,
  };
  merged.sort((a, b) => {
    if (b.votes !== a.votes) return b.votes - a.votes;
    if (sevRank[a.severity] !== sevRank[b.severity]) {
      return sevRank[a.severity] - sevRank[b.severity];
    }
    return a.line - b.line;
  });

  return merged;
}

function pickCanonical(variants: Finding[]): Finding {
  // Longest `why` first (proxy for richest explanation), then highest
  // confidence, then alphabetical title for determinism.
  const confRank = { high: 0, medium: 1, low: 2 } as const;
  return [...variants].sort((a, b) => {
    if (b.why.length !== a.why.length) return b.why.length - a.why.length;
    if (confRank[a.confidence] !== confRank[b.confidence]) {
      return confRank[a.confidence] - confRank[b.confidence];
    }
    return a.title.localeCompare(b.title);
  })[0]!;
}
