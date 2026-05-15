/**
 * Schema for spec findings.
 *
 * The discriminated union over `kind` is the entire taxonomy — six values,
 * one sentence each in the prompt. Add a kind only when a fixture proves
 * the existing six don't cover a real failure mode.
 */

import { z } from "zod";

const Severity = z.enum(["critical", "high", "medium", "low"]);
const Confidence = z.enum(["high", "medium", "low"]);

const Base = z.object({
  severity: Severity,
  /** 1-indexed line in the input markdown where the issue starts. */
  line: z.number().int().positive(),
  title: z.string().min(1).max(200),
  why: z.string().min(1),
  confidence: Confidence,
});

export const FindingSchema = z
  .discriminatedUnion("kind", [
    Base.extend({ kind: z.literal("missing-section") }),
    Base.extend({ kind: z.literal("ambiguity") }),
    Base.extend({ kind: z.literal("untestable-claim") }),
    Base.extend({ kind: z.literal("scope-creep") }),
    Base.extend({ kind: z.literal("broken-reference") }),
    Base.extend({ kind: z.literal("undefined-term") }),
  ]);

export type Finding = z.infer<typeof FindingSchema>;
export type FindingKind = Finding["kind"];

export const FindingsArraySchema = z.array(FindingSchema);

/**
 * Wrapper for the agent-SDK structured output. Root must be an object.
 */
export const ReviewResponseSchema = z.object({
  findings: FindingsArraySchema,
});

export type ReviewResponse = z.infer<typeof ReviewResponseSchema>;

/**
 * A merged finding produced by voting across N samples. Same shape as the
 * source Finding plus provenance fields.
 */
export interface VotedFinding {
  id: string;
  kind: FindingKind;
  severity: Finding["severity"];
  line: number;
  title: string;
  why: string;
  confidence: Finding["confidence"];
  votes: number;
  totalSamples: number;
  variants: Finding[];
}
