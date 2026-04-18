/**
 * Fixture scoring.
 *
 * A fixture has an `expected.json` listing the findings Oracle SHOULD
 * surface for a given diff. We score a fixture by checking which
 * expecteds were hit, and tracking unexpected findings as potential
 * false positives.
 *
 * "Potential" because Oracle reviewing real code frequently finds things
 * that are legitimate but not in our curated list — especially in
 * private fixtures. We count them for visibility but treat them as
 * warnings, not hard failures, unless the fixture's `allowExtras` is
 * false.
 *
 * Metrics we surface per run:
 *   - recall    = matched-expecteds / total-expecteds
 *   - precision = matched-findings / total-findings
 *   - pass      = recall == 1.0 AND (allowExtras OR precision == 1.0)
 */

import type { VotedRecommendation } from "../src/schema.js";

export interface Expected {
  key: string;
  kind:
    | "bug" | "security" | "performance" | "refactor"
    | "architectural" | "convention" | "question";
  file: string;
  startLine: number;
  endLine: number;
  severity?: "critical" | "high" | "medium" | "low";
  minSeverity?: "critical" | "high" | "medium" | "low";
  /**
   * Any of these kinds count as a match. Defaults to [kind].
   * Useful when a real bug could reasonably be flagged as either
   * "bug" or "security" (etc.).
   */
  acceptableKinds?: Expected["kind"][];
  /**
   * If set, at least half of these phrases (case-insensitive substring
   * match) must appear in the finding's `why` for it to count.
   * Ensures the model identified the ACTUAL issue, not a coincidentally
   * overlapping one.
   */
  requiredPhrases?: string[];
  lineTolerance?: number;
}

export interface FixtureExpected {
  name: string;
  description: string;
  expected: Expected[];
  /**
   * Extra findings (ones not in `expected`) are allowed if true.
   * Default true — most real diffs will surface legit things we
   * didn't curate.
   */
  allowExtras?: boolean;
}

export interface Match {
  expectedKey: string;
  findingId: string;
  votes: number;
}

export interface Score {
  name: string;
  matches: Match[];
  missed: Expected[];
  extras: VotedRecommendation[];
  recall: number;
  precision: number;
  pass: boolean;
  findingsCount: number;
  expectedCount: number;
}

export function scoreFixture(
  fixture: FixtureExpected,
  findings: VotedRecommendation[],
): Score {
  const matches: Match[] = [];
  const missed: Expected[] = [];
  const matchedFindingIds = new Set<string>();

  for (const exp of fixture.expected) {
    const hit = findings.find((f) =>
      !matchedFindingIds.has(f.id) && isMatch(exp, f),
    );
    if (hit) {
      matches.push({ expectedKey: exp.key, findingId: hit.id, votes: hit.votes });
      matchedFindingIds.add(hit.id);
    } else {
      missed.push(exp);
    }
  }

  const extras = findings.filter((f) => !matchedFindingIds.has(f.id));

  const recall = fixture.expected.length === 0
    ? 1
    : matches.length / fixture.expected.length;
  const precision = findings.length === 0
    ? 1
    : matches.length / findings.length;

  const allowExtras = fixture.allowExtras ?? true;
  const pass = recall === 1 && (allowExtras || precision === 1);

  return {
    name: fixture.name,
    matches,
    missed,
    extras,
    recall,
    precision,
    pass,
    findingsCount: findings.length,
    expectedCount: fixture.expected.length,
  };
}

function isMatch(exp: Expected, f: VotedRecommendation): boolean {
  if (normalizePath(exp.file) !== normalizePath(f.file)) return false;

  const tolerance = exp.lineTolerance ?? 2;
  const expStart = exp.startLine - tolerance;
  const expEnd   = exp.endLine   + tolerance;
  if (f.endLine < expStart || f.startLine > expEnd) return false;

  const acceptable = exp.acceptableKinds ?? [exp.kind];
  if (!acceptable.includes(f.kind)) return false;

  if (exp.minSeverity && severityRank(f.severity) > severityRank(exp.minSeverity)) {
    return false;
  }

  if (exp.requiredPhrases && exp.requiredPhrases.length > 0) {
    const why = f.why.toLowerCase();
    const hits = exp.requiredPhrases.filter((p) => why.includes(p.toLowerCase())).length;
    if (hits < Math.ceil(exp.requiredPhrases.length / 2)) return false;
  }

  return true;
}

function normalizePath(p: string): string {
  return p.replace(/^\.\//, "").replace(/\\/g, "/");
}

function severityRank(s: Expected["severity"] | VotedRecommendation["severity"]): number {
  switch (s) {
    case "critical": return 0;
    case "high":     return 1;
    case "medium":   return 2;
    case "low":      return 3;
    default:         return 4;
  }
}

export interface AggregateMetrics {
  fixtures: number;
  passed: number;
  failed: number;
  overallRecall: number;
  overallPrecision: number;
  avgFindingsPerFixture: number;
}

export function aggregate(scores: Score[]): AggregateMetrics {
  const fixtures = scores.length;
  if (fixtures === 0) {
    return {
      fixtures: 0, passed: 0, failed: 0,
      overallRecall: 1, overallPrecision: 1,
      avgFindingsPerFixture: 0,
    };
  }
  const totalExpected = scores.reduce((n, s) => n + s.expectedCount, 0);
  const totalMatched  = scores.reduce((n, s) => n + s.matches.length, 0);
  const totalFindings = scores.reduce((n, s) => n + s.findingsCount, 0);
  return {
    fixtures,
    passed: scores.filter((s) => s.pass).length,
    failed: scores.filter((s) => !s.pass).length,
    overallRecall:    totalExpected === 0 ? 1 : totalMatched / totalExpected,
    overallPrecision: totalFindings === 0 ? 1 : totalMatched / totalFindings,
    avgFindingsPerFixture: totalFindings / fixtures,
  };
}
