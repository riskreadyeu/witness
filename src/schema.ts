/**
 * Schema for Witness recommendations.
 *
 * This is both:
 *   - the runtime validator (Zod) that catches model hallucinations
 *     before they reach the CLI output, and
 *   - the compile-time type (inferred) that the rest of the codebase
 *     can rely on.
 *
 * Union-of-objects pattern: each `kind` is its own shape. We keep them
 * structurally identical for v0.1 (same fields), but splitting by kind
 * at the type level makes it trivial to add kind-specific fields later
 * (e.g., `exploitVector` on security, `bigO` on performance) without
 * breaking consumers.
 */

import { z } from "zod";

const Severity = z.enum(["critical", "high", "medium", "low"]);
const Confidence = z.enum(["high", "medium", "low"]);

/**
 * Path containment check. The agent's tools are rooted at the repo, so
 * every legitimate finding cites a repo-relative path. We reject anything
 * that looks like an attempt to escape the root: absolute paths, parent
 * traversals, home expansion, Windows drive letters, null bytes. This is
 * defense in depth — a hijacked agent that emits `file: "../../etc/passwd"`
 * (e.g., via prompt injection) gets rejected at parse time and never
 * enters the voting pool or the rendered output.
 */
const SafeRepoPath = z
  .string()
  .min(1)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.startsWith("~") &&
      !/^[A-Za-z]:[\\/]/.test(p) &&
      !p.split(/[\\/]/).includes("..") &&
      !p.includes("\0"),
    {
      message:
        "file must be a repo-relative path (no absolute, no '..', no '~', no drive letter)",
    },
  );

const Base = z.object({
  severity: Severity,
  file: SafeRepoPath,
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  title: z.string().min(1).max(200),
  why: z.string().min(1),
  confidence: Confidence,
});

export const RecommendationSchema = z.discriminatedUnion("kind", [
  Base.extend({ kind: z.literal("bug") }),
  Base.extend({ kind: z.literal("security") }),
  Base.extend({ kind: z.literal("performance") }),
  Base.extend({ kind: z.literal("refactor") }),
  Base.extend({ kind: z.literal("architectural") }),
  Base.extend({ kind: z.literal("convention") }),
  Base.extend({ kind: z.literal("question") }),
]);

export type Recommendation = z.infer<typeof RecommendationSchema>;
export type RecommendationKind = Recommendation["kind"];

export const RecommendationArraySchema = z.array(RecommendationSchema);

/**
 * Wrapper schema for the agent-SDK structured output.
 *
 * The Claude Agent SDK's `outputFormat: { type: 'json_schema' }` requires
 * the root to be an object (not an array). So we wrap our findings list
 * in `{ findings: [...] }`. The CLI / voting layer peels it off.
 */
export const ReviewResponseSchema = z.object({
  findings: RecommendationArraySchema,
});

export type ReviewResponse = z.infer<typeof ReviewResponseSchema>;

/**
 * A merged recommendation produced by voting across N samples.
 * Carries provenance so the CLI can show vote counts transparently.
 */
export interface VotedRecommendation {
  id: string;
  kind: RecommendationKind;
  severity: Recommendation["severity"];
  file: string;
  startLine: number;
  endLine: number;
  title: string;
  why: string;
  confidence: Recommendation["confidence"];
  votes: number;
  totalSamples: number;
  variants: Recommendation[];
}
