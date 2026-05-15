/**
 * Schema for prompt-stage findings.
 *
 * Six finding kinds, one discriminated union. Add a kind only when a
 * fixture proves the existing six don't cover a real failure mode.
 */

import { z } from "zod";

const Severity = z.enum(["critical", "high", "medium", "low"]);
const Confidence = z.enum(["high", "medium", "low"]);

const Base = z.object({
  severity: Severity,
  /** 1-indexed line in the input artifact where the issue is anchored. */
  line: z.number().int().positive(),
  title: z.string().min(1).max(200),
  why: z.string().min(1),
  confidence: Confidence,
});

export const FindingSchema = z.discriminatedUnion("kind", [
    Base.extend({ kind: z.literal("jailbreak-surface") }),
    Base.extend({ kind: z.literal("ambiguous-instruction") }),
    Base.extend({ kind: z.literal("missing-refusal-path") }),
    Base.extend({ kind: z.literal("format-leak") }),
    Base.extend({ kind: z.literal("context-overflow-risk") }),
    Base.extend({ kind: z.literal("evaluation-gap") })
  ]);

export type Finding = z.infer<typeof FindingSchema>;
export type FindingKind = Finding["kind"];

export const FindingsArraySchema = z.array(FindingSchema);

export const ReviewResponseSchema = z.object({
  findings: FindingsArraySchema,
});

export type ReviewResponse = z.infer<typeof ReviewResponseSchema>;

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
