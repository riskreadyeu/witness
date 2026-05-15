---
project: witness
task: Refactor witness into SDLC review suite — Sprint 1.1
slug: sdlc-suite-v0.2
effort: E3
phase: execute
progress: 0/34
mode: build
started: 2026-05-15
updated: 2026-05-15
---

## Problem

Witness today reviews one artifact kind (code diffs) and `spec` reviews another (PRDs / specs). They share an architectural recipe — short prompt + read-only tools + JSON schema + N-sample voting + dissent log + eval harness — captured in `HARNESS-PATTERN.md`. Two repos, duplicated infrastructure, separate auth, separate eval pools, separate distribution. As we add more SDLC stages (design review, prompt review, eval design, deploy gate), each new stage would duplicate the harness again. The SDLC coverage story breaks at the seams.

## Vision

A single tool, `witness review --stage <name>`, that covers the AI-app SDLC: spec → design → diff → prompt → eval-design → deploy. One auth path, one cache, one dissent log, one fixture pool, one CLI surface. Each stage is a thin adapter on a shared parent+subagent harness. Adding a new stage costs a prompt + a finding taxonomy + fixtures, not new infrastructure. The euphoric surprise: a vibe coder runs `witness review --stage spec PRD.md` on a ChatGPT-generated PRD and gets back the same shape of grounded findings they get when witness reviews their next diff — same trust model, same dissent surface, zero new tools to learn.

## Out of Scope

- Stage 7 (production trace review) — different architecture entirely (streaming + sampling, not voting on a static artifact). Lives in `src/trace/` later, NOT in this refactor.
- Writing tools — witness stays Oracle-only. No mutation, no execution, no push.
- Pushing this branch to GitHub. Daniel reviews local first.
- Touching the `spec` repo directly. Migration happens in Sprint 1.3 by copying logic INTO witness — `spec` stays untouched.
- Changing CLI default behavior for v0.1 users beyond default-samples 5→3 (documented).
- Bumping dependencies. Same SDK version, same zod, same vitest.

## Principles

- **The harness is the product.** Stages are configuration of the harness, not new harnesses.
- **Read-only is the only mode.** Every stage operates inside the Bostrom Oracle envelope.
- **Voting beats trust.** N samples + min-votes is the floor, not a feature flag.
- **Dissent is data.** Every dropped finding is a lesson; nothing is silently discarded.
- **Eval before ship.** A new stage isn't merged without fixtures.

## Constraints

- Node 20+, TypeScript strict, pnpm package manager — preserve existing toolchain.
- `@anthropic-ai/claude-agent-sdk` and `codex exec` backends both stay functional.
- Existing CLI flags keep working in v0.2 (additive, not breaking).
- Repo layout change: `src/` flat → `src/core/` + `src/stages/<name>/`.
- Branch `feat/sdlc-suite-v0.2` does NOT push to origin during this sprint.
- Main branch HEAD `bd9dec4` must remain untouched.

## Goal

Refactor witness from flat `src/` into `src/core/` (shared harness) plus `src/stages/diff/` (current behavior) on a feature branch, change default samples 5→3, and prove via pnpm typecheck + pnpm test that the rearrangement is purely structural — zero behavior change vs. main HEAD. This Sprint (1.1) ships the substrate that Sprint 1.2 (parent+subagent+cache) and Sprint 1.3 (port spec → stages/spec) build on.

## Criteria

- [ ] ISC-1: Branch `feat/sdlc-suite-v0.2` exists on mndesktop and is checked out
- [ ] ISC-2: Project ISA exists at `/home/daniel/projects/witness/ISA.md`
- [ ] ISC-3: `src/core/` directory exists
- [ ] ISC-4: `src/stages/diff/` directory exists
- [ ] ISC-5: `src/core/auth.ts` exists (git-mv from `src/auth.ts`)
- [ ] ISC-6: `src/core/voting.ts` exists (git-mv)
- [ ] ISC-7: `src/core/voting.test.ts` exists (git-mv)
- [ ] ISC-8: `src/core/dissent.ts` exists (git-mv)
- [ ] ISC-9: `src/core/dissent.test.ts` exists (git-mv)
- [ ] ISC-10: `src/core/schema.ts` exists (git-mv)
- [ ] ISC-11: `src/core/schema.test.ts` exists (git-mv)
- [ ] ISC-12: `src/core/json-schema.ts` exists (git-mv)
- [ ] ISC-13: `src/stages/diff/diff.ts` exists (git-mv)
- [ ] ISC-14: `src/stages/diff/diff.test.ts` exists (git-mv)
- [ ] ISC-15: `src/stages/diff/backend.ts` exists (git-mv)
- [ ] ISC-16: `src/stages/diff/codex-backend.ts` exists (git-mv)
- [ ] ISC-17: `src/stages/diff/codex-backend.test.ts` exists (git-mv)
- [ ] ISC-18: `src/stages/diff/prompt.ts` exists (git-mv)
- [ ] ISC-19: `src/stages/diff/render.ts` exists (git-mv)
- [ ] ISC-20: `src/stages/diff/render.test.ts` exists (git-mv)
- [ ] ISC-21: `src/stages/diff/witness.ts` exists (git-mv)
- [ ] ISC-22: `src/stages/diff/witness.test.ts` exists (git-mv)
- [ ] ISC-23: `src/index.ts` imports updated to point at `./core/*` and `./stages/diff/*`
- [ ] ISC-24: All moved `.ts` files have imports updated to new relative paths
- [ ] ISC-25: All moved `.test.ts` files have imports updated
- [ ] ISC-26: `pnpm typecheck` exits 0
- [ ] ISC-27: `pnpm test` passes all test files (same count as main: 9)
- [ ] ISC-28: Default samples constant changed from 5 to 3 in `src/index.ts`
- [ ] ISC-29: `pnpm witness --help` still prints help (CLI loads without crash)
- [ ] ISC-30: Commit on `feat/sdlc-suite-v0.2` with conventional message
- [ ] ISC-31: Anti: `main` branch HEAD unchanged (still `bd9dec4`)
- [ ] ISC-32: Anti: branch is not pushed to origin
- [ ] ISC-33: Anti: `package.json` dependencies block unchanged
- [ ] ISC-34: Anti: README content unchanged in this sprint (Sprint 1.4 task)

## Test Strategy

| ISC | Type | Check | Threshold | Tool |
|-----|------|-------|-----------|------|
| 1 | git | `git branch --show-current` returns `feat/sdlc-suite-v0.2` | exact match | ssh + git |
| 2 | file | ISA.md readable at canonical path | exists | ssh + ls |
| 3-4 | dir | directory listing | exists | ssh + ls -d |
| 5-22 | file | file at new path; old path absent | exists at new, absent at old | ssh + ls + git status |
| 23-25 | grep | no `from "./auth"` / `from "./voting"` etc. survive at top level | 0 matches | ssh + rg |
| 26 | exit | `pnpm typecheck` exit code | =0 | ssh + pnpm |
| 27 | exit | `pnpm test` exit code | =0 | ssh + pnpm |
| 28 | grep | `samples.*3` in index.ts default config; no remaining `5` default | matches | ssh + rg |
| 29 | exit | `pnpm witness --help` exit code | =0 | ssh + pnpm |
| 30 | git | `git log -1 --oneline` | branch HEAD has expected message | ssh + git |
| 31 | git | `git rev-parse main` | =bd9dec4 | ssh + git |
| 32 | git | `git ls-remote origin feat/sdlc-suite-v0.2` | empty | ssh + git |
| 33 | git | `git diff main -- package.json` deps section | only scripts/version diffs allowed | ssh + git |
| 34 | git | `git diff main -- README.md` | empty | ssh + git |

## Features

| name | satisfies | depends_on | parallelizable |
|------|-----------|-----------|----------------|
| F1 branch + ISA seed | ISC-1, ISC-2 | — | no |
| F2 directory creation | ISC-3, ISC-4 | F1 | no |
| F3 git mv to core | ISC-5..12 | F2 | yes (all mvs) |
| F4 git mv to stages/diff | ISC-13..22 | F2 | yes (all mvs) |
| F5 import rewrites | ISC-23..25 | F3, F4 | yes (per file) |
| F6 default samples flip | ISC-28 | F5 | no |
| F7 verification | ISC-26, 27, 29 | F6 | no (sequential) |
| F8 commit | ISC-30..34 | F7 | no |

## Decisions

- 2026-05-15: Lane B (full SDLC suite) confirmed by Daniel after 7-stage pattern review.
- 2026-05-15: Build location = extend witness in-place (option 1a). New repo/monorepo rejected.
- 2026-05-15: Default samples 5 → 3 per cost-reduction analysis (60% cost cut at marginal recall loss).
- 2026-05-15: Sprint scoped to refactor-only. parent-agent/subagent + cache deferred to Sprint 1.2; spec port deferred to Sprint 1.3.
- 2026-05-15: pnpm kept (Daniel's choice for this repo); the PAI "bun always" rule applies only to PAI tooling.
- 2026-05-15: Stage 7 (production trace) explicitly out-of-scope; different architecture per earlier analysis.
- 2026-05-15: effort_source = context-override; classifier returned NATIVE on "continua" but the conversation thread is clearly an active multi-step implementation. Escalated to E3.

## Changelog

(none yet — first run of this ISA)

## Verification

(populated at VERIFY phase)

### Refinements (post-Advisor 2026-05-15)

- refined: Commit ordering split into 3 — Commit A pure git mv (no content edits, preserves git log --follow), Commit B import + config rewrites, Commit C default samples 5→3.
- refined: ISC-30 acknowledged as a SINGLE commit was incorrect — replace with three commits ISC-30a, ISC-30b, ISC-30c (ID-stability: split rule).
- refined: Pre-verify wipe dist/ on mndesktop so typecheck/test run against fresh emit.
- refined: README inspection cleared — single `src/user-service.ts` reference is inside a fixture-tree example, not a witness source-path reference. No README edit needed.
- refined: No vitest.config.ts; no .github/workflows; no snapshot files; no dynamic imports. Static rewrite is sufficient.
- refined: madge --circular skipped — not installed on mndesktop. Add to Sprint 1.4 deliverables instead.
- refined: Test files contain string fixtures like `"src/user.ts"` — these are mock finding payloads, NOT path references. No change needed.

### Criteria — additions

- [ ] ISC-30a: Commit A "refactor: git mv src/ → core/ + stages/diff/" on feat/sdlc-suite-v0.2 (no content changes)
- [ ] ISC-30b: Commit B "refactor: rewrite imports for core/ + stages/diff/ split" on feat/sdlc-suite-v0.2
- [ ] ISC-30c: Commit C "feat: lower default samples 5 → 3" on feat/sdlc-suite-v0.2
- [ ] ISC-35: `dist/` removed before final verify (clean re-emit)
- [ ] ISC-36: `git log --follow src/core/auth.ts` resolves back to original `src/auth.ts` history
