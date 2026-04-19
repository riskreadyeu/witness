/**
 * Multi-sample voting.
 *
 * We run the model N times at non-zero temperature and merge overlapping
 * recommendations. The merge strategy:
 *
 *   1. Compute a stable ID per recommendation from (file, startLine,
 *      endLine, kind). We deliberately do NOT hash `why` — the model
 *      rephrases the same finding every sample, so hashing `why` would
 *      split every vote of 1.
 *   2. Bucket by ID. Count votes.
 *   3. For each bucket, pick the canonical text by choosing the variant
 *      with the longest `why` (proxy for richest explanation), then fall
 *      back to the highest confidence, then alphabetical.
 *   4. Emit a VotedRecommendation with vote count for transparency.
 *
 * We do NOT merge across kinds or across non-overlapping line ranges.
 * Two findings on the same line that disagree on kind are two findings.
 *
 * Filtering by vote threshold is the caller's responsibility (see
 * witness.ts). This module just counts.
 */

import { createHash } from "node:crypto";
import type { Recommendation, VotedRecommendation } from "./schema.js";

export function stableId(r: Pick<Recommendation, "file" | "startLine" | "endLine" | "kind">): string {
  const key = `${r.file}:${r.startLine}:${r.endLine}:${r.kind}`;
  return createHash("sha1").update(key).digest("hex").slice(0, 12);
}

/**
 * Merge recommendations from N independent samples into voted findings.
 *
 * @param samples - Array of samples. Each sample is the array of
 *                  recommendations from a single model call.
 * @returns VotedRecommendation[] sorted by (votes desc, severity asc).
 */
export function mergeSamples(samples: Recommendation[][]): VotedRecommendation[] {
  const totalSamples = samples.length;
  if (totalSamples === 0) return [];

  const buckets = new Map<string, Recommendation[]>();

  for (const sample of samples) {
    const seenInSample = new Set<string>();
    for (const rec of sample) {
      const id = stableId(rec);
      if (seenInSample.has(id)) continue;
      seenInSample.add(id);

      const existing = buckets.get(id);
      if (existing) existing.push(rec);
      else buckets.set(id, [rec]);
    }
  }

  const voted: VotedRecommendation[] = [];
  for (const [id, variants] of buckets) {
    const canonical = pickCanonical(variants);
    voted.push({
      id,
      kind: canonical.kind,
      severity: canonical.severity,
      file: canonical.file,
      startLine: canonical.startLine,
      endLine: canonical.endLine,
      title: canonical.title,
      why: canonical.why,
      confidence: canonical.confidence,
      votes: variants.length,
      totalSamples,
      variants,
    });
  }

  voted.sort((a, b) => {
    if (a.votes !== b.votes) return b.votes - a.votes;
    return severityRank(a.severity) - severityRank(b.severity);
  });

  return voted;
}

function pickCanonical(variants: Recommendation[]): Recommendation {
  const sorted = [...variants].sort((a, b) => {
    if (a.why.length !== b.why.length) return b.why.length - a.why.length;
    const conf = confidenceRank(a.confidence) - confidenceRank(b.confidence);
    if (conf !== 0) return conf;
    return a.title.localeCompare(b.title);
  });
  const first = sorted[0];
  if (!first) throw new Error("pickCanonical called with empty variants");
  return first;
}

function severityRank(s: Recommendation["severity"]): number {
  switch (s) {
    case "critical": return 0;
    case "high":     return 1;
    case "medium":   return 2;
    case "low":      return 3;
  }
}

function confidenceRank(c: Recommendation["confidence"]): number {
  switch (c) {
    case "high":   return 0;
    case "medium": return 1;
    case "low":    return 2;
  }
}
