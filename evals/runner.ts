/**
 * Eval runner.
 *
 * Loads every fixture under a pool directory (public, private, or both),
 * runs Witness against its diff, scores the result, writes a results
 * JSON, and prints a table.
 *
 * A "fixture" is a directory containing:
 *   - diff.patch          the input change to review
 *   - before/             (optional) files as they existed before
 *   - after/              files as they exist after the change; this is
 *                         what Witness reads when collecting context
 *   - expected.json       { name, description, expected: [...] }
 *
 * We pass Witness the fixture's `after/` directory as repoRoot. The
 * diff's `+++ b/...` paths must resolve inside `after/`.
 *
 * Usage:
 *   tsx evals/runner.ts --pool public
 *   tsx evals/runner.ts --pool private
 *   tsx evals/runner.ts --pool all
 *   tsx evals/runner.ts --pool public --samples 3 --fixture 001-*
 *   tsx evals/runner.ts --pool public --dry-run   (validate schemas without API calls)
 */

import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { review } from "../src/witness.js";
import { scoreFixture, aggregate, type FixtureExpected, type Score } from "./score.js";
import type { VotedRecommendation } from "../src/schema.js";
import type { BackendKind } from "../src/backend.js";

interface RunnerArgs {
  pool: "public" | "private" | "all";
  samples?: number;
  minVotes?: number;
  model?: string;
  backend?: BackendKind;
  fixtureFilter?: string;
  dryRun: boolean;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = resolve(__dirname, "..");
const PUBLIC_POOL  = join(REPO, "evals", "fixtures");
const PRIVATE_POOL = join(REPO, "evals", "fixtures-private");
const RESULTS_DIR  = join(REPO, "evals", "results");

function parseArgs(argv: string[]): RunnerArgs {
  const args: RunnerArgs = { pool: "public", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    switch (a) {
      case "--pool":      args.pool = (argv[++i] as RunnerArgs["pool"]) ?? "public"; break;
      case "--samples": {
        const n = Number.parseInt(argv[++i] ?? "", 10);
        if (Number.isFinite(n) && n > 0) args.samples = n;
        break;
      }
      case "--min-votes": {
        const n = Number.parseInt(argv[++i] ?? "", 10);
        if (Number.isFinite(n) && n > 0) args.minVotes = n;
        break;
      }
      case "--model":     args.model = argv[++i]; break;
      case "--backend": {
        const raw = argv[++i];
        if (raw === "claude" || raw === "codex") args.backend = raw;
        break;
      }
      case "--fixture":   args.fixtureFilter = argv[++i]; break;
      case "--dry-run":   args.dryRun = true; break;
    }
  }
  return args;
}

async function listFixtures(poolDir: string): Promise<string[]> {
  try {
    const entries = await readdir(poolDir);
    const dirs: string[] = [];
    for (const e of entries) {
      const full = join(poolDir, e);
      const st = await stat(full).catch(() => null);
      if (st?.isDirectory()) dirs.push(full);
    }
    return dirs.sort();
  } catch {
    return [];
  }
}

async function loadFixture(dir: string): Promise<{
  path: string;
  diff: string;
  expected: FixtureExpected;
  afterDir: string;
}> {
  const diff     = await readFile(join(dir, "diff.patch"), "utf-8");
  const metadata = JSON.parse(await readFile(join(dir, "expected.json"), "utf-8")) as FixtureExpected;
  const afterDir = join(dir, "after");
  return { path: dir, diff, expected: metadata, afterDir };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const dirs: string[] = [];
  if (args.pool === "public"  || args.pool === "all") dirs.push(...(await listFixtures(PUBLIC_POOL)));
  if (args.pool === "private" || args.pool === "all") dirs.push(...(await listFixtures(PRIVATE_POOL)));

  const filtered = args.fixtureFilter
    ? dirs.filter((d) => d.includes(args.fixtureFilter!))
    : dirs;

  if (filtered.length === 0) {
    console.error(`no fixtures found in pool=${args.pool}${args.fixtureFilter ? ` matching ${args.fixtureFilter}` : ""}`);
    console.error(`  public  pool: ${PUBLIC_POOL}`);
    console.error(`  private pool: ${PRIVATE_POOL}`);
    process.exit(1);
  }

  if (args.dryRun) {
    console.log(`dry-run: validating ${filtered.length} fixture(s)`);
    let dryRunFailures = 0;
    for (const d of filtered) {
      try {
        const f = await loadFixture(d);
        console.log(`  ok  ${f.expected.name} (${f.expected.expected.length} expected findings)`);
      } catch (e) {
        dryRunFailures++;
        console.log(`  FAIL ${d}: ${(e as Error).message}`);
      }
    }
    if (dryRunFailures > 0) {
      console.error(`\n${dryRunFailures}/${filtered.length} fixture(s) failed schema validation`);
      process.exit(1);
    }
    return;
  }

  console.log(`running ${filtered.length} fixture(s)...\n`);

  const scores: Score[] = [];
  const runResults: Array<{
    fixture: string;
    findings: VotedRecommendation[];
    meta?: { samplesRequested: number; samplesParsed: number; parseErrors: string[] };
  }> = [];
  const erroredFixtures: Array<{ fixture: string; message: string }> = [];

  for (const d of filtered) {
    const f = await loadFixture(d);
    process.stdout.write(`  ${f.expected.name}... `);
    try {
      const result = await review({
        diff: f.diff,
        repoRoot: f.afterDir,
        ...(args.samples  !== undefined ? { samples: args.samples } : {}),
        ...(args.minVotes !== undefined ? { minVotes: args.minVotes } : {}),
        ...(args.model    !== undefined ? { model: args.model } : {}),
        ...(args.backend  !== undefined ? { backend: args.backend } : {}),
      });
      const score = scoreFixture(f.expected, result.findings);
      scores.push(score);
      const parseErrors = result.raw.parseErrors.map(
        (p) => `sample ${p.sampleIndex}: ${p.error} — ${p.detail}`,
      );
      runResults.push({
        fixture: f.expected.name,
        findings: result.findings,
        meta: {
          samplesRequested: result.meta.samplesRequested,
          samplesParsed: result.meta.samplesParsed,
          parseErrors,
        },
      });
      const verdict = score.pass ? "PASS" : "FAIL";
      console.log(
        `${verdict}  recall=${fmtPct(score.recall)} precision=${fmtPct(score.precision)} ` +
        `(${score.matches.length}/${score.expectedCount} expected, ${score.findingsCount} total, ${result.meta.samplesParsed}/${result.meta.samplesRequested} samples)`,
      );
      if (result.meta.samplesParsed === 0 && parseErrors.length) {
        for (const err of parseErrors.slice(0, 3)) {
          console.log(`      ! ${err}`);
        }
      }
    } catch (e) {
      // The fixture didn't even produce a result — SDK threw, auth broke,
      // model rejected the request, etc. Track it separately so the run
      // exits non-zero. Silent failure here means CI can go green while
      // the eval harness didn't actually evaluate.
      const message = e instanceof Error ? (e.stack ?? e.message) : String(e);
      erroredFixtures.push({ fixture: f.expected.name, message });
      const headline = e instanceof Error ? e.message : String(e);
      console.log(`ERROR  ${headline}`);
    }
  }

  const agg = aggregate(scores);
  console.log("");
  console.log("─".repeat(60));
  console.log(`passed:    ${agg.passed}/${agg.fixtures}`);
  console.log(`recall:    ${fmtPct(agg.overallRecall)} overall`);
  console.log(`precision: ${fmtPct(agg.overallPrecision)} overall`);
  console.log(`avg findings/fixture: ${agg.avgFindingsPerFixture.toFixed(1)}`);
  if (erroredFixtures.length > 0) {
    console.log(`errored:   ${erroredFixtures.length}/${filtered.length} (no result produced)`);
    for (const err of erroredFixtures) {
      console.log(`  ! ${err.fixture}: ${err.message.split("\n")[0]}`);
    }
  }

  await mkdir(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const resultsPath = join(RESULTS_DIR, `run-${stamp}.json`);
  await writeFile(
    resultsPath,
    JSON.stringify({ args, agg, scores, runResults, erroredFixtures }, null, 2),
    "utf-8",
  );
  console.log(`\nwrote ${resultsPath}`);

  process.exit(agg.failed === 0 && erroredFixtures.length === 0 ? 0 : 1);
}

function fmtPct(n: number): string {
  return `${Math.round(n * 1000) / 10}%`.padStart(6);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
