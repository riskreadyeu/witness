#!/usr/bin/env node
/**
 * Witness CLI entrypoint.
 *
 * Usage:
 *   witness                   review current diff (HEAD vs working tree)
 *   witness --staged          review only staged diff
 *   witness --range HEAD~3    review diff from HEAD~3 to working tree
 *   witness --diff FILE.patch review a pre-built diff from disk
 *   witness --samples 7       override sample count
 *   witness --min-votes 3     override vote threshold
 *   witness --max-turns 60    raise per-sample turn cap (default 40)
 *   witness --budget 2.0      per-sample USD cap (default 1.0; total ≈ budget × samples)
 *   witness --force           skip the large-unborn-HEAD safety rail
 *   witness --json            emit JSON instead of human output
 *
 * Auth: delegated to the Claude Agent SDK. Either `claude login`
 * (Pro/Max subscription) OR `ANTHROPIC_API_KEY` must be configured.
 * We don't check which — the SDK does.
 */

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { readDiffInput } from "./diff.js";
import { review } from "./witness.js";
import { renderFindings, renderTotalFailure } from "./render.js";
import {
  type DissentAction,
  loadLastReview,
  logDissent,
  persistLastReview,
  resolveFindingByIdPrefix,
} from "./dissent.js";
import type { BackendKind } from "./backend.js";
import { type AuthOverride, defaultBudgetForAuth, describeAuth, detectAuth } from "./auth.js";

interface CliArgs {
  diffFile?: string;
  range?: string;
  staged: boolean;
  samples?: number;
  minVotes?: number;
  model?: string;
  backend?: BackendKind;
  maxBudgetUsd?: number;
  maxTurns?: number;
  authOverride?: AuthOverride;
  json: boolean;
  quiet: boolean;
  force: boolean;
  help: boolean;
}

function parsePositiveInt(raw: string | undefined, flag: string): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`${flag} expects a positive integer (got: ${raw ?? "<missing>"})`);
    process.exit(2);
  }
  return n;
}

function parsePositiveFloat(raw: string | undefined, flag: string): number {
  const n = Number.parseFloat(raw ?? "");
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`${flag} expects a positive number (got: ${raw ?? "<missing>"})`);
    process.exit(2);
  }
  return n;
}

function parseBackend(raw: string | undefined): BackendKind {
  if (raw === "claude" || raw === "codex") return raw;
  console.error(`--backend expects "claude" or "codex" (got: ${raw ?? "<missing>"})`);
  process.exit(2);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { staged: false, json: false, quiet: false, force: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    switch (a) {
      case "-h":
      case "--help":      args.help = true; break;
      case "--staged":    args.staged = true; break;
      case "--json":      args.json = true; break;
      case "--force":     args.force = true; break;
      case "--quiet":
      case "-q":          args.quiet = true; break;
      case "--diff":      args.diffFile = argv[++i]; break;
      case "--range":     args.range = argv[++i]; break;
      case "--samples":   args.samples  = parsePositiveInt(argv[++i], "--samples"); break;
      case "--min-votes": args.minVotes = parsePositiveInt(argv[++i], "--min-votes"); break;
      case "--max-turns": args.maxTurns = parsePositiveInt(argv[++i], "--max-turns"); break;
      case "--budget":    args.maxBudgetUsd = parsePositiveFloat(argv[++i], "--budget"); break;
      case "--auth": {
        const v = argv[++i];
        if (v !== "auto" && v !== "subscription" && v !== "api-key") {
          console.error(
            `--auth expects auto, subscription, or api-key (got: ${v ?? "<missing>"})`,
          );
          process.exit(2);
        }
        args.authOverride = v;
        break;
      }
      case "--model":     args.model = argv[++i]; break;
      case "--backend":   args.backend = parseBackend(argv[++i]); break;
      default:
        if (a.startsWith("--")) {
          console.error(`unknown flag: ${a}`);
          process.exit(2);
        }
    }
  }
  // Some flags only apply to the Claude SDK backend, which enforces them
  // in-process. Codex has its own config for analogous limits and we don't
  // pipe these through, so silently accepting them would set up a footgun
  // where users think they bounded the run and didn't.
  if (args.backend === "codex") {
    if (args.maxBudgetUsd !== undefined) {
      console.error(
        `--budget is not supported with --backend codex. Configure cost limits in your codex config instead.`,
      );
      process.exit(2);
    }
    if (args.maxTurns !== undefined) {
      console.error(
        `--max-turns is not supported with --backend codex. Configure turn limits in your codex config instead.`,
      );
      process.exit(2);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`witness — read-only AI code review

usage:
  witness [options]                              review the current diff
  witness dissent <id> --action <a> [--note ""]  log accepted|dismissed|deferred
                                                  on a finding from the last
                                                  review (see --help on the
                                                  subcommand for details)

options:
  --staged              review staged diff only
  --range <ref>         review diff between <ref> and working tree
  --diff <file>         review a pre-built .patch file (must live inside the
                        repo). Use \`--diff -\` to read a patch from stdin.
  --samples <n>         number of model samples (default 5)
  --min-votes <n>       minimum votes to surface a finding (default 2)
  --max-turns <n>       max tool-use turns per sample (default 40)
  --backend <name>      reviewer backend: claude or codex (default claude)
  --model <id>          override the model
  --budget <usd>        Claude per-sample USD cap. Default depends on auth:
                          subscription → $10 (theoretical, you don't pay it)
                          api-key      → $1  (real money, runaway protection)
                        Not supported with --backend codex.
  --auth <mode>         auto | subscription | api-key (default: auto-detect
                          from presence of ~/.claude/.credentials.json)
  --json                emit JSON instead of human output
  --quiet, -q           suppress progress output on stderr
  --force               skip the safety rails (large-diff warning on unborn HEAD)
  -h, --help            show this help

auth:
  For the default Claude backend, authentication is handled by the Claude Agent SDK. Either:
    - run \`claude login\` once (uses your Claude Pro/Max subscription), or
    - export ANTHROPIC_API_KEY=sk-ant-...

  The SDK picks whichever is configured. Subscription is preferred.
  For \`--backend codex\`, run \`codex login\` and configure Codex first.
`);
}

function git(argv: string[], cwd: string): string {
  return execFileSync("git", argv, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 20 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Canonical SHA of the empty tree in every git repo since forever.
 * We use this as the baseline when HEAD doesn't exist yet (fresh repo,
 * before the first commit), so Witness can still review tracked content.
 */
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function assertSafeRef(ref: string): void {
  if (!/^[A-Za-z0-9_./~^@-]+$/.test(ref)) {
    throw new Error(`refusing suspicious ref: ${ref}`);
  }
}

function hasHead(repoRoot: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", "HEAD"], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

interface DiffSource {
  diff: string;
  /** True when we synthesized a diff against the empty tree (no HEAD exists). */
  fromEmptyTree: boolean;
}


async function getDiff(args: CliArgs, repoRoot: string): Promise<DiffSource> {
  if (args.diffFile) {
    const diff = await readDiffInput(args.diffFile, repoRoot);
    return { diff, fromEmptyTree: false };
  }
  if (args.range) {
    assertSafeRef(args.range);
    return { diff: git(["diff", args.range], repoRoot), fromEmptyTree: false };
  }
  if (args.staged) {
    return { diff: git(["diff", "--staged"], repoRoot), fromEmptyTree: false };
  }
  // Default: working tree vs HEAD. If HEAD doesn't exist yet (repo with no
  // commits), fall back to the empty tree so Witness can still review the
  // initial set of tracked files.
  if (!hasHead(repoRoot)) {
    const staged = git(["diff", "--staged", EMPTY_TREE_SHA], repoRoot);
    if (staged.trim()) return { diff: staged, fromEmptyTree: true };
    // Nothing staged either — try the full index+untracked view against
    // the empty tree by walking tracked files. `git diff` without HEAD
    // and without an index won't include untracked files, so we nudge
    // the user.
    const tracked = git(["diff", EMPTY_TREE_SHA], repoRoot);
    if (tracked.trim()) return { diff: tracked, fromEmptyTree: true };
    throw new Error(
      "no commits yet and nothing staged.\n" +
        "This repo has no HEAD, so there's nothing for Witness to diff against.\n" +
        "Try one of:\n" +
        "  git add -N .         # mark all untracked files as intent-to-add\n" +
        "  git add . && witness --staged\n" +
        "  git commit -m 'init' # then run witness normally",
    );
  }
  return { diff: git(["diff", "HEAD"], repoRoot), fromEmptyTree: false };
}

/**
 * Size above which a no-HEAD-fallback diff is almost certainly going to
 * starve the agent on turn budget. Empirically, 169 KB / 5 samples / 20
 * turns burned all turns reading files and returned nothing. 32 KB is
 * the threshold where we pump the brakes and ask the user to narrow scope.
 */
const EMPTY_TREE_WARN_BYTES = 32 * 1024;

function explainError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);

  // execFileSync attaches stderr on the thrown error. Surface it cleanly
  // instead of letting "Command failed: git diff HEAD" swallow the real
  // reason. Node puts stderr on `err.stderr` as a Buffer.
  const stderr = (err as { stderr?: Buffer | string } | null)?.stderr;
  if (stderr) {
    const tail = typeof stderr === "string" ? stderr : stderr.toString("utf-8");
    if (/ambiguous argument 'HEAD'|unknown revision/i.test(tail)) {
      return (
        "witness: can't diff against HEAD — this repo has no commits yet.\n\n" +
        "Try one of:\n" +
        "  git add -N .          # mark untracked files as intent-to-add, then\n" +
        "  witness               # will diff them against the empty tree\n" +
        "  git add . && witness --staged\n" +
        "  git commit -m 'init'  # then just run witness"
      );
    }
    return `witness: ${tail.trim()}`;
  }

  if (/not.*logged in|ANTHROPIC_API_KEY|no.*credentials/i.test(msg)) {
    return (
      `witness: no Claude credentials found.\n\n` +
      `Either run:\n` +
      `  claude login              # uses your Claude Pro/Max subscription\n` +
      `\nor export an API key:\n` +
      `  export ANTHROPIC_API_KEY=sk-ant-...\n\n` +
      `Original error: ${msg}`
    );
  }
  if (/ENOENT|claude.*executable|spawn claude/i.test(msg)) {
    return (
      `witness: the \`claude\` CLI is required but was not found on PATH.\n\n` +
      `Install it with:\n` +
      `  npm install -g @anthropic-ai/claude-code\n\n` +
      `Original error: ${msg}`
    );
  }
  return msg;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // Subcommand dispatch — keep the regular review path the default so
  // `witness` with no args still does the most common thing. We only peel
  // off `dissent` here; everything else falls through to flag parsing.
  if (argv[0] === "dissent") {
    return runDissent(argv.slice(1));
  }

  const args = parseArgs(argv);
  if (args.help) { printHelp(); return; }

  const repoRoot = git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
  const { diff, fromEmptyTree } = await getDiff(args, repoRoot);

  if (!diff.trim()) {
    console.error("no diff to review");
    process.exit(1);
  }

  // Safety rail: a full-repo diff against the empty tree almost always
  // starves the agent on turns. Refuse unless --force; nudge toward the
  // workflow the user probably wants.
  if (fromEmptyTree && diff.length > EMPTY_TREE_WARN_BYTES && !args.force) {
    console.error(
      `witness: this repo has no HEAD and the synthesized diff is ${diff.length.toLocaleString()} bytes.\n` +
        `That's the whole codebase, and a 5-sample review of it will almost\n` +
        `certainly run out of turns before producing findings (it just did,\n` +
        `if that's why you're here).\n\n` +
        `Try instead:\n` +
        `  git add -A && git commit -m 'init'   # baseline the repo, then\n` +
        `  witness                               # reviews real incremental diffs\n\n` +
        `Or narrow scope for this run:\n` +
        `  git add path/to/one/file.ts && witness --staged\n\n` +
        `Override this check with --force if you really mean it.`,
    );
    process.exit(1);
  }

  if (!args.quiet) {
    const samples = args.samples ?? 5;
    const backend = args.backend ?? "claude";
    let budgetText = "";
    if (backend === "claude") {
      const auth = detectAuth(args.authOverride);
      const perSample = args.maxBudgetUsd ?? defaultBudgetForAuth(auth);
      const totalCap = perSample * samples;
      const dollarsHint = auth === "subscription" ? " theoretical" : "";
      budgetText =
        ` (${describeAuth(auth)}, $${perSample.toFixed(2)}${dollarsHint}/sample, up to $${totalCap.toFixed(2)} total)`;
    }
    console.error(
      `witness: reviewing ${diff.length.toLocaleString()} bytes of diff with ${samples} samples ` +
        `using ${backend}${budgetText}…`,
    );
    if (fromEmptyTree) {
      console.error(
        `witness: note — no HEAD, diffing against the empty tree (every tracked line is "new")`,
      );
    }
  }

  const result = await review({
    diff,
    repoRoot,
    ...(args.backend           !== undefined ? { backend: args.backend } : {}),
    ...(args.samples           !== undefined ? { samples: args.samples } : {}),
    ...(args.minVotes          !== undefined ? { minVotes: args.minVotes } : {}),
    ...(args.model             !== undefined ? { model: args.model } : {}),
    ...(args.maxBudgetUsd      !== undefined ? { maxBudgetUsdPerSample: args.maxBudgetUsd } : {}),
    ...(args.maxTurns          !== undefined ? { maxTurnsPerSample: args.maxTurns } : {}),
    ...(args.authOverride      !== undefined ? { authOverride: args.authOverride } : {}),
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    // In JSON mode, the caller is scripting against us — still surface the
    // total-failure signal via exit code so `witness --json | …` pipelines
    // can distinguish "no findings" from "everything broke".
    if (result.meta.samplesParsed === 0 && result.meta.samplesRequested > 0) {
      process.exit(1);
    }
    return;
  }

  const totalFailure =
    result.meta.samplesParsed === 0 && result.meta.samplesRequested > 0;

  if (totalFailure) {
    // Loud failure path. The previous behavior was to render
    // "Witness has no findings." here, which was actively misleading —
    // we didn't find nothing, we couldn't even produce structured output.
    console.error(
      renderTotalFailure({
        samplesRequested: result.meta.samplesRequested,
        totalTurns: result.meta.totalTurns,
        totalCostUsd: result.meta.totalCostUsd,
        elapsedMs: result.meta.elapsedMs,
        parseErrors: result.raw.parseErrors,
        backend: result.meta.backend,
      }),
    );
    process.exit(1);
  }

  console.log(renderFindings(result.findings, result.meta));

  // Persist for `witness dissent <id>` lookups. Best-effort — we don't
  // want a write failure (e.g. read-only filesystem) to break the review.
  if (result.findings.length > 0) {
    try {
      await persistLastReview(repoRoot, result.findings);
    } catch (e) {
      if (!args.quiet) {
        console.error(
          `witness: warning — couldn't persist last-review for dissent: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
  }

  if (!args.quiet) {
    const m = result.meta;
    // Cost and turns are Claude-only metrics — codex doesn't expose either
    // to us, so reporting `0 turns · $0.0000` would imply we measured zero.
    // Show only what we actually know.
    const trailer =
      m.backend === "codex"
        ? `${m.samplesParsed}/${m.samplesRequested} samples parsed  ·  codex  ·  ${(m.elapsedMs / 1000).toFixed(1)}s`
        : `${m.samplesParsed}/${m.samplesRequested} samples parsed  ·  ${m.totalTurns} turns  ·  $${m.totalCostUsd.toFixed(4)}  ·  ${(m.elapsedMs / 1000).toFixed(1)}s`;
    console.error(`\n${trailer}`);
  }

  if (result.raw.parseErrors.length > 0) {
    console.error(`\n${result.raw.parseErrors.length} sample(s) failed to parse:`);
    for (const e of result.raw.parseErrors) {
      console.error(`  sample ${e.sampleIndex}: ${e.error}`);
    }
  }
}

/**
 * `witness dissent <id> --action <accepted|dismissed|deferred> [--note "..."]`
 *
 * Records the user's verdict on a finding from the most recent review. The
 * log lives at `<repoRoot>/.witness/dissent.jsonl` (gitignored) and is the
 * closed feedback loop: it's how we learn which findings matter. v0.1
 * is local-only — no network, no upload. The user owns the data.
 */
async function runDissent(argv: string[]): Promise<void> {
  let id: string | undefined;
  let action: DissentAction | undefined;
  let note: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a === "--action") {
      const v = argv[++i];
      if (v !== "accepted" && v !== "dismissed" && v !== "deferred") {
        console.error(
          `--action expects one of: accepted, dismissed, deferred (got: ${v ?? "<missing>"})`,
        );
        process.exit(2);
      }
      action = v;
    } else if (a === "--note") {
      note = argv[++i];
    } else if (a === "-h" || a === "--help") {
      console.log(
        `witness dissent <id> --action <accepted|dismissed|deferred> [--note "..."]\n\n` +
          `Record your verdict on a finding from the most recent review.\n` +
          `<id> may be any unambiguous prefix of the finding's id (shown as #abcd1234\n` +
          `next to each title). Logs to .witness/dissent.jsonl in the repo.`,
      );
      return;
    } else if (!a.startsWith("-") && id === undefined) {
      id = a;
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }

  if (!id) {
    console.error("witness dissent: missing <id>. Run `witness dissent --help`.");
    process.exit(2);
  }
  if (!action) {
    console.error(
      "witness dissent: missing --action. Pick one: accepted, dismissed, deferred.",
    );
    process.exit(2);
  }

  const repoRoot = git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
  const last = await loadLastReview(repoRoot);
  if (!last) {
    console.error(
      "witness dissent: no recent review to dissent against.\n" +
        "Run `witness` first to produce findings, then dissent against the IDs it prints.",
    );
    process.exit(1);
  }

  const lookup = resolveFindingByIdPrefix(last.findings, id);
  if (lookup.kind === "missing") {
    console.error(
      `witness dissent: no finding matches id "${id}" in the last review (${last.ts}).\n` +
        `IDs are 12-char hex; you can pass any unambiguous prefix (8 chars is plenty).`,
    );
    process.exit(1);
  }
  if (lookup.kind === "ambiguous") {
    console.error(
      `witness dissent: id prefix "${id}" matches ${lookup.matches.length} findings:`,
    );
    for (const m of lookup.matches) {
      console.error(`  #${m.id}  ${m.kind}  ${m.file}:${m.startLine}  ${m.title}`);
    }
    console.error("Pass a longer prefix to disambiguate.");
    process.exit(1);
  }

  await logDissent({
    repoRoot,
    rec: lookup.finding,
    action,
    ...(note !== undefined ? { note } : {}),
  });
  console.log(
    `witness: logged ${action} for #${lookup.finding.id} (${lookup.finding.title})`,
  );
}

main().catch((e) => {
  console.error(explainError(e));
  process.exit(1);
});
