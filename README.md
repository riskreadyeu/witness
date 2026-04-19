# witness

A read-only AI pair programmer. No hands, by design.

Witness reads your diff. It does not write, run, or push. It returns
structured recommendations — `bug`, `security`, `performance`,
`refactor`, `architectural`, `convention`, `question` — each cited
to a specific file and line. You decide what to do with them.

> The shape is deliberate. In Bostrom's taxonomy, an **Oracle** answers
> questions; a **Genie** executes instructions; a **Sovereign** pursues
> open-ended goals. Witness is an Oracle in that sense: it observes and
> reports. The riskier categories are already well-served. This one isn't.

## Design thesis

Minimal scaffolding. The product is the model, plus the smallest
possible wrapper to:

1. Give it a reliable structured output format.
2. Vote across multiple samples so low-confidence noise doesn't reach you.
3. Constrain its tools to the set that cannot do damage (read, glob, grep).
4. Log your dissent so we can learn where it's wrong.

Everything else is a temporary ladder that a better model kicks out
from under itself. We will remove it when we can.

## Install

```bash
pnpm install
```

Requires Node 20+.

### Authentication

Witness is built on the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk).
The SDK handles auth; we don't. You have two options:

```bash
# preferred — uses your Claude Pro/Max subscription, zero per-call cost
claude login

# alternative — pay-as-you-go via API credits
export ANTHROPIC_API_KEY=sk-ant-...
```

If `claude login` has been run, the SDK picks that up automatically. If not,
it falls back to the env var. If neither is configured, Witness will tell you
exactly which command to run.

> **Note on Claude subscription usage.** Using your subscription token to
> power a third-party CLI is allowed by the SDK; Anthropic's terms may evolve
> and are on you to respect. If you're redistributing Witness or running it
> inside a commercial product, set `ANTHROPIC_API_KEY` instead.

## Use

```bash
# review your uncommitted diff against HEAD
pnpm witness

# review staged changes only
pnpm witness --staged

# review the diff from main..HEAD
pnpm witness --range main

# review a pre-built patch file
pnpm witness --diff ./some.patch

# machine-readable output
pnpm witness --json
```

For workflow recipes, failure modes, and honest weaknesses, see [USAGE.md](./USAGE.md).

Flags:

| flag | default | purpose |
|---|---|---|
| `--samples <n>` | 5 | model samples to vote across |
| `--min-votes <n>` | 2 | drop findings below this vote count |
| `--max-turns <n>` | 40 | per-sample tool-use turn cap |
| `--model <id>` | `claude-sonnet-4-5-20250929` | override model |
| `--budget <usd>` | 1.0 | per-sample USD cap (total ≈ `budget × samples`) |
| `--json` | off | machine output for editor/PR-bot integration |
| `--quiet`, `-q` | off | suppress progress output on stderr |
| `--force` | off | skip the large-diff safety rail on unborn-HEAD repos |

### How context gets collected

Witness doesn't pre-bundle your codebase. Each sample is a fresh agent session
with read-only access (`Read`, `Grep`, `Glob`) rooted at your repo. The model
decides what to open, which call sites to trace, and which tests to inspect —
same context budget it would use in an IDE, without the foot-guns of Write,
Edit, or Bash. That read-only enforcement lives in the SDK runtime, not in
the prompt.

## Evals

Quality of a reviewer is measured on precision, not just recall.
A noisy reviewer is worse than none. So every change to the prompt,
the voting threshold, or the context strategy runs through the harness:

```bash
pnpm eval              # public fixtures only
pnpm eval:private      # private fixtures (see below)
pnpm eval:all          # both pools

pnpm eval --fixture 002-sql-injection --dry-run
```

Metrics per fixture:

- **recall**    — fraction of expected findings Witness caught
- **precision** — fraction of Witness's findings that match something expected
- **pass**      — `recall == 1` AND (`allowExtras` OR `precision == 1`)

Aggregate across the pool lands in `evals/results/<timestamp>.json`.

### Fixture layout

```
evals/
  fixtures/                   # public, committed to OSS repo
    001-missing-await/
      diff.patch              # input: the unified diff being reviewed
      after/                  # input: post-change file tree
        src/user-service.ts
      expected.json           # scoring: expected findings + rules
  fixtures-private/           # gitignored; populate locally only
    README.md                 # explains non-negotiables
```

### Private fixtures (RiskReadyEU, etc.)

If you have a closed-source repo with real bugs fixed in real commits,
you can mine it for eval fixtures without leaking code:

```bash
pnpm extract-fixtures \
  --repo /path/to/your/private/repo \
  --commit <sha> \
  --name 010-real-bug-we-caught \
  --kind bug
```

The extractor is read-only: it uses `git show` / `git diff-tree` only,
and writes the result to `evals/fixtures-private/`, which is gitignored.
Hand-annotate the generated `expected.json` before running evals.

Batch mode:

```bash
pnpm extract-fixtures \
  --repo /path/to/repo \
  --batch ./evals/riskreadyeu-batch.json
```

`riskreadyeu-batch.json` is a list of `{ commit, name, kind?, description? }`.
Keep it local — it also contains SHAs from your private repo.

## Development

```bash
pnpm typecheck
pnpm test
pnpm build
```

## Roadmap

- **v0.1 (now)**: CLI on the Claude Agent SDK, 5-sample vote, read-only
  tools (`Read`/`Grep`/`Glob`), JSON-schema structured output,
  subscription-or-API-key auth, 5 public fixtures, private-fixture
  extractor.
- **v0.2**: OS sandbox (bubblewrap / sandbox-exec / Docker) around reads
  as defense-in-depth, MCP tool exposure, git hosted-bot integration
  (PR comments).
- **v0.3**: Incremental review (only re-score the diff hunks that
  changed), smarter context collection, custom ruleset per repo
  via `.witness/config.yaml`.

## Philosophy

We don't write much. We just show.
