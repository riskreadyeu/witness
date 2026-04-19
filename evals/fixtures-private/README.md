# private fixtures

This directory holds eval fixtures extracted from **closed-source** repositories (e.g., RiskReadyEU).

## non-negotiables

- **Contents are gitignored.** The only committed file here is this README. Do not `git add` anything else.
- **Do not share these fixtures.** They contain proprietary code. They exist to improve Witness's quality on realistic codebases without leaking the source.
- **Read-only extraction only.** The extraction script (`evals/extract-riskreadyeu.ts`) uses `git show` / `git diff` exclusively. It never mutates the source repo.

## how to populate

```bash
pnpm extract-fixtures --repo /home/daniel/projects/RISKREADYEU --out ./evals/fixtures-private
```

## how to run

```bash
pnpm eval:private   # private pool only
pnpm eval:all       # public + private
```

Public fixtures live in `../fixtures/` and are committed to the Witness OSS repo.
