# Making witness mandatory

By default, `witness` is opt-in. You remember to run it (or you don't, and the bad commit lands). This document gives you five enforcement layers, ordered from softest to hardest, with copy-pasteable snippets. Pick the layer that matches your risk surface — solo repos rarely need a CI gate; shared production code usually does.

The right answer for most teams is a combination: a pre-commit hook for the common case (catches the obvious stuff before it leaves your machine) and a CI gate for the must-not-merge case (catches the rest before it reaches main).

## Layer 1 — Claude Code slash command

The lightest layer. Witness becomes one keystroke away inside Claude Code, but you have to remember to type `/review`. Good for solo work and exploratory tooling repos.

Create `.claude/commands/review.md` in any repo:

```markdown
---
description: Review staged changes with witness before commit
---

Below is the output of `witness --staged` against the current staged diff.
Read it carefully and present the findings to the user. If witness raises
anything (bug, security, performance, architectural, convention,
question), ask whether to address it before committing.

Notes for interpretation:
- Witness votes across N parallel SDK samples; findings below `--min-votes`
  are already filtered out.
- Each finding has a short id like `#abcd1234`. The user can log a verdict
  with `witness dissent <id> --action accepted|dismissed|deferred`.

If the run errors (no staged changes, auth issue), report verbatim and stop.

!`witness --staged`
```

Variations for the other stages:

```markdown
# .claude/commands/review-spec.md
!`witness spec docs/PRD.md`

# .claude/commands/review-design.md
!`witness design docs/architecture.md`

# .claude/commands/review-deploy.md
!`witness deploy docker-compose.yaml`
```

**Bypass cost:** zero. You just don't type `/review`. Use this for habit-building, not enforcement.

## Layer 2 — PAI operational rule

If you run a Personal AI Infrastructure (Claude Code with custom CLAUDE.md), add witness to the rules your DA enforces conversationally. Your DA will then refuse to commit, push, or publish without surfacing witness findings first.

Append to `~/.claude/CLAUDE.md` Operational Rules section:

```markdown
- **Witness gate before publishing**. Before any commit, push, PR opening,
  or document publish in user projects, run the appropriate witness stage
  and surface findings. Block the action if witness emits critical
  severity findings. Reasoning the user can override; silent skipping is
  a doctrine violation.
```

**Bypass cost:** the user has to override explicitly. The DA holds the line.

## Layer 3 — git pre-commit hook (Husky)

Blocks the commit locally before any bytes leave the working tree. Best per-repo enforcement: short feedback loop, doesn't depend on CI being healthy.

If Husky is already installed in the repo (look for `.husky/`):

```bash
# in repo root
cat > .husky/pre-commit <<'HOOK'
#!/usr/bin/env bash
set -eo pipefail

if ! command -v witness >/dev/null 2>&1; then
  echo "witness not on PATH — skipping (install: npm i -g @riskready/witness or build from ~/projects/witness)"
  exit 0
fi

# Diff stage: review only if there are staged code changes
STAGED=$(git diff --cached --name-only --diff-filter=ACMR)
if [ -z "$STAGED" ]; then exit 0; fi

witness --staged --quiet || {
  echo
  echo "witness flagged findings on this commit. Review with: witness --staged"
  echo "To commit anyway: git commit --no-verify"
  exit 1
}
HOOK
chmod +x .husky/pre-commit
```

If Husky is NOT installed yet:

```bash
pnpm add -D husky
pnpm exec husky init
# then write .husky/pre-commit as above
```

**Bypass cost:** `git commit --no-verify` exists. Use that escape hatch only when you mean it (incident response, WIP commits to a feature branch).

## Layer 4 — pre-push hook

Less noisy than pre-commit (fires once per push instead of every commit). Good if your team commits frequently in small chunks but pushes in batches.

```bash
cat > .husky/pre-push <<'HOOK'
#!/usr/bin/env bash
set -eo pipefail

REMOTE="$1"
REMOTE_BRANCH=$(git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || echo "")
if [ -z "$REMOTE_BRANCH" ]; then exit 0; fi

RANGE="${REMOTE_BRANCH}..HEAD"
if ! git rev-list --count "$RANGE" >/dev/null 2>&1; then exit 0; fi

if ! command -v witness >/dev/null 2>&1; then exit 0; fi

witness --range "$RANGE" --quiet || {
  echo "witness flagged findings on this push range. Bypass: git push --no-verify"
  exit 1
}
HOOK
chmod +x .husky/pre-push
```

## Layer 5 — CI gate (GitHub Actions)

Hardest layer. Witness runs server-side on every PR; branch protection rules require the check to pass before merge. Bypassing this needs admin rights on the repo.

Save as `.github/workflows/witness.yml`:

```yaml
name: witness
on:
  pull_request:
    branches: [ main ]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # need full history for --range

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - uses: pnpm/action-setup@v3
        with:
          version: 9

      - name: Install witness
        run: |
          git clone --depth 1 https://github.com/riskreadyeu/witness.git /tmp/witness
          cd /tmp/witness
          pnpm install
          pnpm build
          echo "/tmp/witness/dist/src" >> "$GITHUB_PATH"
          chmod +x /tmp/witness/dist/src/index.js
          ln -s /tmp/witness/dist/src/index.js /tmp/witness/dist/src/witness

      - name: Run witness on PR diff
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          BASE_SHA=$(git merge-base origin/${{ github.base_ref }} HEAD)
          witness --range "$BASE_SHA..HEAD" --min-votes 2 --samples 2
```

Then in GitHub repo settings → Branches → main → require status check `witness`.

**Cost note:** every PR triggers a real API run. Budget per CI run ≈ `$samples × $per-sample`. For an active repo, this can add up. Tune `--samples 2` and `--max-turns 30` to keep it predictable; tighten or loosen based on what your dissent log says about precision.

## Stage-specific enforcement

Witness is six stages, not one. Different artifacts → different stages → different hooks.

```bash
# In .husky/pre-commit — branch on file types changed
STAGED=$(git diff --cached --name-only --diff-filter=ACMR)

if echo "$STAGED" | grep -qE '\.(ts|tsx|js|py|go|rs)$'; then
  witness --staged --quiet || exit 1
fi

if echo "$STAGED" | grep -qE 'docs/specs/.*\.md$'; then
  for f in $(echo "$STAGED" | grep -E 'docs/specs/.*\.md$'); do
    witness spec "$f" --quiet || exit 1
  done
fi

if echo "$STAGED" | grep -qE '(Dockerfile|docker-compose\.yml|\.tf|\.github/workflows/.*\.yml)$'; then
  for f in $(echo "$STAGED" | grep -E '(Dockerfile|docker-compose\.yml|\.tf|workflows/.*\.yml)$'); do
    witness deploy "$f" --quiet || exit 1
  done
fi
```

The `--quiet` flag suppresses successful no-finding output so the hook is silent on a clean commit and only speaks when there's something to look at.

## What "blocking" actually means

A few realities to keep honest:

- **Bypass exists by design.** `git commit --no-verify`, `git push --no-verify`, admin-merge in GitHub. The point of the gate is not to make bypass impossible, but to make the bypass deliberate — the cost of bypassing should be one explicit flag, not "I forgot to run the review."

- **Cost discipline matters more than blocking discipline.** A pre-commit hook that costs $2 per commit will train you to either bypass it constantly or commit less. Set `--samples 2`, `--max-turns` reasonably tight, and use the cheapest stage that matches the artifact.

- **The dissent log is how you calibrate.** Every finding you dismiss tells you the rule was over-strict. Look at `.witness/dissent.jsonl` periodically and retune thresholds rather than learning to ignore the tool.

## Recommended starting setup

For Daniel's three active projects today:

| Repo | Layer 1 | Layer 3 | Layer 5 |
|------|---------|---------|---------|
| `LexAi` (real users) | ✓ (done) | add pre-commit | add CI gate before launch |
| `riskreadylocal` (daily build) | ✓ | add pre-commit (.husky exists) | not yet |
| `cvflip` | optional | optional | not needed |

Add Layer 2 (PAI operational rule) at the global CLAUDE.md level once — it covers all projects with no per-repo work.
