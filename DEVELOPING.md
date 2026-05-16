# Developing witness

Read this before you touch the code. It tells you the architecture, where things live, how to add a new stage, how to add a finding kind, how to run and test, and the cost knobs you should understand before generating bills you didn't expect.

## 1. What witness is

A read-only AI reviewer. Bostrom's taxonomy: **Oracle** (observes and reports — no Write, no Edit, no Bash, no push). Six stages today; each reviews one kind of SDLC artifact:

| # | Stage | Subcommand | Artifact |
|---|---|---|---|
| 1 | spec | `witness spec <md>` | PRD / spec / ADR markdown |
| 2 | design | `witness design <md>` | architecture docs (Mermaid/PlantUML ok) |
| 3 | diff | `witness` | git diff |
| 4 | prompt | `witness prompt <md>` | LLM system prompts |
| 5 | eval-design | `witness eval-design <md>` | eval configs / fixture plans |
| 6 | deploy | `witness deploy <md>` | Dockerfile / k8s / Terraform / CI |
| 7 | trace | (not built) | production trace / log stream — different architecture |

Same harness: short prompt + read-only tools (Read + Grep ± Glob) + JSON-schema-structured output + N parallel samples + voting + dissent log.

## 2. Repo layout

```
witness/
├── README.md                 — user-facing intro + per-stage usage
├── HARNESS-PATTERN.md        — design thesis ("the product is the model")
├── ISA.md                    — project ISA (PAI Algorithm system of record)
├── package.json              — pnpm; scripts: typecheck, test, eval, circular
├── tsconfig.json             — strict TS, NodeNext modules
├── src/
│   ├── index.ts              — CLI: subcommand dispatch + per-stage handlers
│   ├── core/                 — stage-agnostic substrate
│   │   ├── auth.ts           — detect subscription vs API key; default budget
│   │   ├── schema.ts         — diff-stage Recommendation (NOT shared by spec/design/...)
│   │   ├── voting.ts         — diff-stage voting (file+startLine+endLine+kind ID)
│   │   ├── dissent.ts        — dissent log on .witness/dissent.jsonl
│   │   ├── json-schema.ts    — zod→JSON-schema bridge (diff stage)
│   │   └── subagent-runner.ts — generic Promise.all-over-N-samples SDK runner
│   └── stages/
│       ├── diff/             — original code-diff stage (claude + codex backends)
│       ├── spec/             — PRD/spec stage
│       ├── design/           — architecture stage
│       ├── prompt/           — uses instructions.ts (avoids prompt.ts filename clash)
│       ├── eval-design/      — eval/fixture stage
│       └── deploy/           — IaC stage
└── evals/
    ├── runner.ts             — eval harness for the diff stage
    ├── score.ts              — recall / precision scoring
    └── fixtures/             — public eval fixtures (001-missing-await, etc.)
```

**Key invariants:**

- Every stage owns its own `schema.ts` and `voting.ts`. The voting stable-ID rule **differs per stage** (diff: file+lines+kind; spec/design/etc.: line+kind). Don't try to share `core/voting.ts` across stages — it's diff-shaped.
- Every stage's runtime (`<name>.ts`) calls `core/subagent-runner.runSamples()`. The diff stage has its own dual-backend pattern (claude + codex) and does NOT go through the runner — that's a known follow-up.
- `src/index.ts` is the single CLI entry. Subcommands branch on `argv[0]` before flag parsing.
- The prompt stage uses `instructions.ts` for its system prompt, because `prompt.ts` is its stage runtime filename. Every other stage uses `prompt.ts` for the system prompt.

## 3. Running locally

Requires Node 20+ and pnpm.

```bash
git clone https://github.com/riskreadyeu/witness.git
cd witness
pnpm install
pnpm typecheck       # tsc --noEmit
pnpm test            # vitest (65 tests)
pnpm circular        # madge --circular on src/
pnpm witness --help  # diff stage help
```

### On mndesktop

The dev environment uses nvm. Non-interactive SSH shells don't load nvm by default; export the path:

```bash
export PATH="/home/daniel/.nvm/versions/node/v20.19.6/bin:$PATH"
```

(Or pin whatever version `ls /home/daniel/.nvm/versions/node/` shows is current.)

### Auth

The Claude Agent SDK looks for credentials in this order:

1. `ANTHROPIC_API_KEY` env var — if set, API-key auth. **Real money.**
2. `~/.claude/.credentials.json` — OAuth from `claude login` (Pro/Max subscription).

Important: **even with subscription OAuth present, the SDK currently bills as `service_tier: standard` (API rates).** The OAuth bearer is recognized by the `claude` CLI for chat but not by the SDK's underlying API call. Treat every witness invocation as real-money API spend until an SDK update closes the gap. See `README.md → Cost notes`.

## 4. Invoking the stages

Each stage takes a file path (except diff, which reads from git):

```bash
witness                              # diff: review the unstaged diff
witness --staged                     # diff: review the staged diff
witness --range main..HEAD           # diff: review a ref range

witness spec        path/to/PRD.md
witness design      path/to/architecture.md
witness prompt      path/to/system-prompt.txt
witness eval-design path/to/eval-plan.md
witness deploy      path/to/Dockerfile.md

witness dissent <id> --action accepted|dismissed|deferred --note "..."
```

Common flags (all stages):

```
--samples <n>      override default sample count (default: 2)
--min-votes <n>    override minimum votes to surface a finding (default: 2)
--budget <usd>     per-sample USD cap
--max-turns <n>    per-sample tool-use turn cap
--model <id>       override Claude model id (default claude-opus-4-7)
```

## 5. Adding a new stage

The pattern is a 5-file directory + 3 small edits in `src/index.ts`.

### 5.1 Design the taxonomy first

A stage is defined by **six finding kinds** — a tight discriminated union. Don't ship a stage with three kinds you padded out, and don't ship with twelve. Six is the budget the user can hold in working memory; more dilutes calibration. Each kind needs one sentence in the system prompt that says exactly when to emit it and exactly when NOT to.

### 5.2 Create `src/stages/<name>/` with five files

```
src/stages/<name>/
├── schema.ts        — z.discriminatedUnion("kind", [...]) over your 6 kinds + VotedFinding type
├── json-schema.ts   — zodToJsonSchema(ReviewResponseSchema, { name, $refStrategy: "none" }) + inlineRoot()
├── voting.ts        — stableId(f) — choose the key that uniquely identifies a finding's identity for vote-bucketing
├── prompt.ts        — SYSTEM_PROMPT export as a JS template literal (or instructions.ts if your stage name is "prompt")
└── <name>.ts        — review() function that builds userMessage, calls core/subagent-runner.runSamples(), validates each sample with ReviewResponseSchema, merges with mergeSamples(), filters by minVotes
```

You can copy `src/stages/spec/` verbatim and edit:
- `schema.ts` — swap the 6 z.literal kinds.
- `prompt.ts` — rewrite the SYSTEM_PROMPT body. **Inside the JS template literal, escape every literal backtick as `\``.** (See §8 — the templating gotcha is real.)
- `<name>.ts` — rename function exports; nothing else.
- `voting.ts` — only changes if your stage anchors findings by something other than `(line, kind)`.

### 5.3 Wire CLI dispatch in `src/index.ts`

Three insertions:

```ts
// near the top, with the other stage imports
import { review as <name>Review } from "./stages/<name>/<name>.js";
```

```ts
// in main(), after the spec/design/prompt/etc. branches:
if (argv[0] === "<name>") {
  return run<Name>(argv.slice(1));
}
```

```ts
// append a runX handler at end of file — copy runDesign and edit
// the stage name, help text, and the import_name passed to the review call.
```

### 5.4 Verify

```bash
pnpm typecheck                 # must exit 0
pnpm test                      # 65 tests must still pass
pnpm circular                  # must report no cycles
pnpm witness <name> --help     # must print your stage's help
pnpm witness <name> <some-artifact-path> --samples 1   # one cheap sample to confirm it talks to the SDK
```

### 5.5 Add an eval (optional but recommended for v0.3+)

The eval harness today is diff-stage-only (`evals/runner.ts` and `evals/fixtures/`). Stages 2–6 do not have fixture pools yet. Adding one means:

1. Define `evals/fixtures-<stage>/<NNN>-<name>/` with the artifact + `expected.json` (an explicit set of expected findings keyed by stage's stable-ID).
2. Generalize `evals/runner.ts` to accept a `--stage <name>` flag and dispatch to that stage's `review()`.
3. Score against `expected.json`.

This isn't done. It's the most valuable place to spend the next hour of dev time once a stage stabilizes.

## 6. Adding a new finding kind to an existing stage

Less common but cheap:

1. Add a `z.literal("<new-kind>")` in `stages/<stage>/schema.ts`'s `discriminatedUnion`.
2. Add one sentence in `stages/<stage>/prompt.ts`'s taxonomy block: name + definition + the criterion that distinguishes it from existing kinds.
3. Run `pnpm typecheck` (the discriminated union changes propagate through every consumer).
4. Run one cheap probe: `pnpm witness <stage> <artifact> --samples 1`. Look at the JSON output for whether the model uses the new kind.
5. Add a fixture where the new kind is the *expected* finding.

If the model never emits the new kind, the prompt definition isn't sharp enough. Tighten it. Resist the urge to add a fourth kind to cover the same surface — collapse instead.

## 7. Cost tuning

The honest defaults (v0.3+):

```ts
// in each stage's <name>.ts
const DEFAULTS = {
  model: "claude-opus-4-7",
  samples: 2,
  minVotes: 2,
  maxTurnsPerSample: <per-stage>,   // 20-40, tuned to observed-average + headroom
};
```

**Per-stage max-turns:** diff 40, spec 30, design 30, prompt 20, eval-design 40, deploy 40. These are tuned to "observed average × 1.5–2." Cutting more aggressively starved samples in our testing: they ran out of turns before emitting structured output, and the sample was scored as a parse failure (zero findings reached voting).

**Cheaper options (opt-in, not default):**

```bash
--model claude-haiku-4-5-20251001    # ~15× cheaper; expect 0 findings on long-context artifacts
--samples 1 --min-votes 1            # quick preview, no voting filter
```

**Reference cost on an 812-line PRD (spec stage):**

| Config | Cost | Voted findings |
|---|---|---|
| v0.2 default (3 samples, Opus, max-turns 30) | $7.00 | 4 |
| v0.3 default (2 samples, Opus, max-turns 30) | $1.70 | 1 high-severity (real) |
| Haiku probe (2 samples, max-turns 20) | $0.40 | 0 (1 sample parse-failed) |

## 8. Templating gotchas

When generating stages with a templating script (see `git log` around commit `90a9a2b` for an example):

- **JS template literals don't tolerate unescaped backticks in the body.** If your taxonomy descriptions contain `` `latest` `` or `` `0.0.0.0` ``, escape every literal backtick in the SYSTEM_PROMPT body to `\``. A multi-pass escape will silently produce `\\`` (double-escape) which TypeScript parses as a literal backslash followed by an unescaped backtick — and the parser eats half your prompt.
- **Don't share `core/voting.ts` across stages.** Each stage's stable-ID rule lives with the stage. Move it to `core/` only when two stages need *the same* ID rule.
- **`persistSession: false` bypasses SDK auto-caching.** You can't easily re-enable session caching while preserving N-independent-samples. The path to real prompt caching is either an SDK update that exposes `cache_control` on `systemPrompt`, or rewriting against `@anthropic-ai/sdk` directly + a hand-rolled tool-use loop.

## 9. Testing

Unit tests live alongside source files: `src/core/voting.test.ts`, `src/stages/diff/render.test.ts`, etc. Vitest. The runner mocks the SDK via `__setQuery()` in `core/subagent-runner.ts`; new stages can rely on the runner test for SDK-level invocation coverage and add stage-specific tests for the schema and voting.

```bash
pnpm test                              # full suite (~400ms)
pnpm test --reporter=verbose           # see each test
pnpm test src/stages/spec              # one directory
```

Real-API E2E is not in `vitest`. The closest thing is the eval harness (`pnpm eval --fixture <prefix> --samples N`) and direct CLI invocation (`pnpm witness <stage> <path> --samples 1`).

## 10. What stays the same: the design constraints

- **Read-only.** No stage may add Write, Edit, Bash, or any tool that mutates. Adding such a tool means you're building a Genie, not an Oracle, and it does not belong in witness.
- **Six finding kinds per stage.** Add a seventh only when a fixture proves the existing six don't cover the failure mode.
- **N parallel samples + min-votes.** Voting is the only thing standing between noisy single-shot generation and trustworthy findings. Don't ship a stage with `samples: 1` as the default.
- **The dissent log is data.** Findings users mark dismissed go into `.witness/dissent.jsonl`. Use that signal to retune prompts and thresholds. Don't tune from vibes.
