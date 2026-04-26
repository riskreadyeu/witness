# Using Witness

This is the practical guide. For the why, see `README.md`.

## What you actually get

You run `witness`, it reads the diff you're about to commit, and prints
a list of findings. Each finding has:

- a **kind** (`bug`, `security`, `performance`, `refactor`,
  `architectural`, `convention`, `question`)
- a **severity** (`critical` / `high` / `medium` / `low`)
- a **confidence** (`high` / `medium` / `low`)
- a **vote count** (how many of the N samples independently flagged it)
- a **file + line range** and a short explanation

That's it. Witness does not open PRs, post comments, or edit files.

## Before your first run

1. **Node 20+** and **pnpm**.
2. Authenticate the backend you want to use. For the default Claude backend:
   ```bash
   claude login                       # uses your Claude Pro/Max subscription (preferred)
   export ANTHROPIC_API_KEY=sk-ant-… # pay-as-you-go alternative
   ```
   For the Codex backend:
   ```bash
   codex login
   ```
3. From the repo root:
   ```bash
   pnpm install
   pnpm build
   ```

## The four commands you'll actually use

```bash
pnpm witness                     # review uncommitted changes vs HEAD
pnpm witness --staged            # review only what's staged
pnpm witness --range main        # review everything between main and HEAD
pnpm witness --diff ./x.patch    # review a pre-built patch file
pnpm witness --backend codex     # run the same review loop through Codex
```

Add `--json` if you want machine output. Add `--quiet` if you want to
suppress progress on stderr.

## The right time to run it

**Run Witness just before you open a PR**, after you think the change is
done but before a human looks at it. That's where the value is:
mechanical things a careful human catches on a slow day but misses on a
busy one.

Don't run it during active development. The signal-to-noise is worse
when the code is half-finished.

## Reading the output

Sort your attention by this rule of thumb:

| Votes | Confidence | Treat as |
|---|---|---|
| 4-5 / 5 | high   | Almost certainly real. Fix or justify. |
| 4-5 / 5 | medium | Real. Read it carefully. |
| 2-3 / 5 | any    | Worth reading. Some will be noise. |
| 1 / 5   | —      | Already filtered out by default (`--min-votes 2`). |

Findings of kind `question` mean Witness wants information the diff
didn't give it. Answer the question in your PR description or in a
code comment; the question itself often reveals whether there's a
real issue.

## What it's good at

Based on real-world dogfood data:

- **Mechanical bugs.** Missing `await`, off-by-one, null dereference.
- **Obvious security.** Hardcoded secrets, SQL injection, unvalidated
  input into crypto primitives.
- **Error-handling hygiene.** Empty catches, swallowed errors.
- **Consistency.** Convention drift when the rest of the codebase does
  it differently.

On these categories you can trust high-vote findings close to blindly.

## What it's weak at — be honest with yourself

- **Performance reasoning that requires profiling intuition.** It can
  spot obviously bad big-O; it cannot tell you which of two reasonable
  approaches will be faster in production.
- **Architectural judgement.** It will flag cross-module calls but
  won't know if the architecture you're building *wants* that.
- **Adversarial security beyond the common patterns.** Side-channels,
  parser differentials, timing leaks. It catches some of these now
  thanks to the adversarial prompt pass, but this class stays weaker
  than mechanical bugs.
- **Severity calibration on the highest-impact findings.** A HIGH bug
  will sometimes get reported as MEDIUM. Read `why` before trusting
  the severity tag.

**When in doubt, Witness is a junior reviewer, not a staff engineer.**
Treat it as the pass that catches what a tired human misses, not the
pass that replaces the review itself.

## When a finding is wrong

Two cases:

1. **You're sure it's wrong.** Dismiss it. Move on. Witness is designed
   to be quiet enough that false positives are cheap.
2. **You're not sure.** Re-run with `--samples 7 --min-votes 4`. If the
   finding still appears with 4+ votes out of 7, that's a strong
   signal. If it drops out, it was noise.

For `question` kind: the model is telling you it doesn't know something
about your codebase. Usually the answer is to add a comment or update
a type, not to argue with the finding.

## Cost expectations

- A typical 5-10KB diff runs about $0.50-$1.50 at 5 samples.
- A 13KB crypto diff ran at $0.98 / 72s in our dogfood.
- The default Claude budget cap is `$1.00` per sample (`--budget`), so
  a 5-sample run is capped at about `$5.00` total.
- If you're on a Claude Pro/Max subscription and used `claude login`,
  subscription usage is effectively free — but subject to Anthropic's
  rate limits and terms.
  Codex backend usage follows your local Codex plan and configuration.

## Common failure modes

**"No commits yet and nothing staged."** You're in a fresh repo with
no HEAD. Either `git commit -m 'init'` to baseline, or stage the files
you want reviewed and use `--staged`.

**"No diff to review."** You have no uncommitted changes. Check with
`git status`.

**Samples fail to parse.** Rare, but surfaces on the stderr summary as
`N/M samples parsed`. Re-run; if it persists, file an issue with the
diff size and model ID.

**Parsing error about the SDK / structured output.** Almost always an
auth issue in disguise. Confirm `claude login` or `ANTHROPIC_API_KEY`.

## Workflow recipes

**Pre-PR check (recommended default):**
```bash
pnpm witness
```
Skim the findings. Fix the ones you agree with. Open the PR.

**Pre-commit check (if your change is crypto/auth/security-adjacent):**
```bash
pnpm witness --samples 7 --min-votes 3
```
Higher N, higher threshold. Slower and more expensive, but you want
the extra signal on security-sensitive code.

**Review a specific range (e.g. someone else's branch):**
```bash
git fetch origin pull/123/head:pr-123
pnpm witness --range main...pr-123
```

**CI integration (JSON out):**
```bash
pnpm witness --json --quiet > witness.json
```
Machine-readable output for editor plugins or PR bots. Schema is
`{ findings: VotedRecommendation[], meta: {...}, raw: {...} }`.

**Codex-backed review:**
```bash
pnpm witness --backend codex --staged
```
This preserves Witness's voting and structured output, but uses
`codex exec` in a read-only sandbox for each sample.

## What Witness won't do — and why that's the point

- It won't modify your code.
- The default Claude backend won't run tests, commands, or shell. The
  Codex backend may run read-only inspection commands inside Codex's
  read-only sandbox.
- It won't enable web search or network fetch tools; backend auth/model calls
  still go through the configured Claude or Codex runtime.
- The reviewer agent won't read files outside the repo root. The Claude
  backend's Read/Grep/Glob tools are sandboxed there by the SDK; the Codex
  backend's `--sandbox read-only --cd <repoRoot>` does the same thing.
- The CLI itself reads patch files from inside the repo (`--diff <path>`)
  or from stdin (`--diff -`). It refuses absolute or `..`-relative paths
  that escape the repo root, so a compromised parent agent calling
  Witness can't coerce it into ingesting `~/.ssh/id_rsa`.

These aren't missing features. The read-only boundary is the product.
