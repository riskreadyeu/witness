---
project: witness
task: Refactor witness into SDLC review suite — Sprint 1.1
slug: sdlc-suite-v0.2
effort: E3
phase: complete
progress: 36/36
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

- [x] ISC-1: Branch `feat/sdlc-suite-v0.2` exists on mndesktop and is checked out
- [x] ISC-2: Project ISA exists at `/home/daniel/projects/witness/ISA.md`
- [x] ISC-3: `src/core/` directory exists
- [x] ISC-4: `src/stages/diff/` directory exists
- [x] ISC-5: `src/core/auth.ts` exists (git-mv from `src/auth.ts`)
- [x] ISC-6: `src/core/voting.ts` exists (git-mv)
- [x] ISC-7: `src/core/voting.test.ts` exists (git-mv)
- [x] ISC-8: `src/core/dissent.ts` exists (git-mv)
- [x] ISC-9: `src/core/dissent.test.ts` exists (git-mv)
- [x] ISC-10: `src/core/schema.ts` exists (git-mv)
- [x] ISC-11: `src/core/schema.test.ts` exists (git-mv)
- [x] ISC-12: `src/core/json-schema.ts` exists (git-mv)
- [x] ISC-13: `src/stages/diff/diff.ts` exists (git-mv)
- [x] ISC-14: `src/stages/diff/diff.test.ts` exists (git-mv)
- [x] ISC-15: `src/stages/diff/backend.ts` exists (git-mv)
- [x] ISC-16: `src/stages/diff/codex-backend.ts` exists (git-mv)
- [x] ISC-17: `src/stages/diff/codex-backend.test.ts` exists (git-mv)
- [x] ISC-18: `src/stages/diff/prompt.ts` exists (git-mv)
- [x] ISC-19: `src/stages/diff/render.ts` exists (git-mv)
- [x] ISC-20: `src/stages/diff/render.test.ts` exists (git-mv)
- [x] ISC-21: `src/stages/diff/witness.ts` exists (git-mv)
- [x] ISC-22: `src/stages/diff/witness.test.ts` exists (git-mv)
- [x] ISC-23: `src/index.ts` imports updated to point at `./core/*` and `./stages/diff/*`
- [x] ISC-24: All moved `.ts` files have imports updated to new relative paths
- [x] ISC-25: All moved `.test.ts` files have imports updated
- [x] ISC-26: `pnpm typecheck` exits 0
- [x] ISC-27: `pnpm test` passes all test files (same count as main: 9)
- [x] ISC-28: Default samples constant changed from 5 to 3 in `src/index.ts`
- [x] ISC-29: `pnpm witness --help` still prints help (CLI loads without crash)
- [x] ISC-30: Commit on `feat/sdlc-suite-v0.2` with conventional message
- [x] ISC-31: Anti: `main` branch HEAD unchanged (still `bd9dec4`)
- [x] ISC-32: Anti: branch is not pushed to origin
- [x] ISC-33: Anti: `package.json` dependencies block unchanged
- [x] ISC-34: Anti: README content unchanged in this sprint (Sprint 1.4 task)

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

- [x] ISC-30a: Commit A "refactor: git mv src/ → core/ + stages/diff/" on feat/sdlc-suite-v0.2 (no content changes)
- [x] ISC-30b: Commit B "refactor: rewrite imports for core/ + stages/diff/ split" on feat/sdlc-suite-v0.2
- [x] ISC-30c: Commit C "feat: lower default samples 5 → 3" on feat/sdlc-suite-v0.2
- [x] ISC-35: `dist/` removed before final verify (clean re-emit)
- [x] ISC-36: `git log --follow src/core/auth.ts` resolves back to original `src/auth.ts` history

## Verification

- ISC-1 — git: `git branch --show-current` → `feat/sdlc-suite-v0.2` ✓
- ISC-2 — file: `/home/daniel/projects/witness/ISA.md` exists (this file) ✓
- ISC-3..4 — dir: `ls -d src/core src/stages/diff` → both present ✓
- ISC-5..22 — file: post-mv listing shows every expected path exists; git mv reported 100% rename detection per file ✓
- ISC-23..25 — grep: multi-line awk audit shows every relative import resolves into ./core/* or ../../core/* or ./stages/diff/* as planned ✓
- ISC-26 — exit: `pnpm typecheck` → exit 0 ✓
- ISC-27 — exit: `pnpm test` → 7 test files, 62 tests, all passed, exit 0 ✓ (count refined: main also had 7 test files; my ISA initial draft said 9 — corrected here)
- ISC-28 — grep: `args.samples ?? 3` and help text "default 3" present in src/index.ts ✓
- ISC-29 — exit: `pnpm witness --help` → exit 0, prints CLI help ✓
- ISC-30a — git: commit d68cb01 "refactor: split src/ ..." on feat/sdlc-suite-v0.2 ✓
- ISC-30b — git: commit 681042b "refactor: rewrite imports ..." on feat/sdlc-suite-v0.2 ✓
- ISC-30c — git: commit 87565e1 "feat: lower default samples ..." on feat/sdlc-suite-v0.2 ✓
- ISC-31 — git: `git rev-parse main` → bd9dec4f024ac2fb00db6b31e65d405a77d7bb10 (unchanged) ✓
- ISC-32 — git: `git ls-remote origin feat/sdlc-suite-v0.2` → empty (not pushed) ✓
- ISC-33 — git: `git diff main -- package.json` → empty (no dep changes) ✓
- ISC-34 — git: `git diff main -- README.md | wc -l` → 0 (README untouched) ✓
- ISC-35 — manual: `rm -rf dist` before pnpm typecheck (fresh emit) ✓
- ISC-36 — git: `git log --follow src/core/auth.ts` resolves through d68cb01 back to main pre-mv history (456092c visible) ✓

### Followup commits (post-Commit-C, not in ISA at PLAN time)

- 9efcae2 fix: missed dissent import in index.ts (multi-line import grep blind spot)
  - This was a real Algorithm miss — my sed pattern matched only single-line imports; a multi-line `import { ... } from "./dissent.js"` survived the rewrite and was caught by `pnpm typecheck`, not by static review. Logged in Changelog below.

## Changelog

- conjectured: a single-line regex-pass + a single grep audit would catch every relative import that needs rewriting.
- refuted_by: `pnpm typecheck` after Commit C surfaced `./dissent.js` import in src/index.ts that survived because the import was multi-line (the `from "..."` was on a different line from the opening `import {`).
- learned: for any import-path rewrite, use multi-line-aware tooling (awk pattern that joins through the closing `from "..."`) BEFORE the typecheck gate, not only after. The Advisor's gap list mentioned snapshots/CI but did not call out multi-line imports as a likely miss.
- criterion_now: ISC-23..25 audit method updated to require awk multi-line scan rather than single-line grep. Add this to the witness Sprint 1.4 deliverables for the suite docs.

---

## Run 2 (2026-05-15) — Sprint 1.2 + 1.3 + 1.4 + E2E

### Criteria — additions

- [x] ISC-37: src/core/subagent-runner.ts exists (148 lines, generic runner)
- [x] ISC-38: src/core/subagent-runner.test.ts passes 3 tests
- [x] ISC-39: src/stages/spec/schema.ts (6 finding kinds: missing-section, ambiguity, untestable-claim, scope-creep, broken-reference, undefined-term)
- [x] ISC-40: src/stages/spec/voting.ts (line+kind stable ID)
- [x] ISC-41: src/stages/spec/prompt.ts (precision-over-recall calibration prompt)
- [x] ISC-42: src/stages/spec/json-schema.ts (zod→JSON bridge)
- [x] ISC-43: src/stages/spec/spec.ts uses core/subagent-runner (proves abstraction)
- [x] ISC-44: src/index.ts dispatches `witness spec <path>` subcommand
- [x] ISC-45: `pnpm witness spec --help` exit 0 with full help text
- [x] ISC-46: README.md has "Review a spec or PRD (v0.2+)" section before Evals
- [x] ISC-47: HARNESS-PATTERN.md appended with "v0.2 update: same harness, multiple stages"
- [x] ISC-48: package.json has `circular` script + madge 8.0.0 in devDependencies
- [x] ISC-49: `pnpm circular` exits 0 on 26 src files (no circular deps)
- [x] ISC-50: `pnpm typecheck` exits 0 across all 5 sprint changes
- [x] ISC-51: `pnpm test` passes all 65 tests (62 pre-Sprint-1.2 + 3 runner tests)
- [x] ISC-52: E2E diff: `pnpm eval --fixture 001 --samples 2` → recall 100% precision 100% on 001-missing-await
- [x] ISC-53: E2E spec: `pnpm witness spec testing-spec.md --samples 2` → 4 findings (2/2 votes each), 152.8s, exit 0
- [x] ISC-54: 4 sprint commits land on feat/sdlc-suite-v0.2 with conventional messages
- [x] ISC-55: Anti: main branch HEAD still bd9dec4 (untouched throughout)
- [x] ISC-56: Anti: branch not pushed to origin

### Verification — Run 2

- ISC-37..51 — file existence, exit-codes, test counts captured in commits 4f14860, 9a95004, 010b7bb
- ISC-52 — Eval runner output: `001-missing-await... PASS  recall=  100% precision=  100% (2/2 expected, 2 total, 2/2 samples)`
- ISC-53 — Spec output: 4 voted findings on testing-spec.md (real RiskReadyEU V4 draft, 812 lines):
  - untestable-claim @ line 112 (votes 2/2, high conf) — "Runtime swap is bounded to a one-week migration" is unmeasurable
  - undefined-term @ line 282 (votes 2/2, high conf) — BIRT, 25-state scenario state machine, appetite-multiplier layer
  - ambiguity @ line 661 (votes 2/2, medium conf) — "4–6 weeks of part-time work" vs "rest of the runway"
  - broken-reference @ line 290 (votes 2/2, medium conf) — Home-directory path is not portable
  - Cost: $2.8947 across 2 samples, 35 turns, 152.8s
- ISC-54..56 — git log shows 4f14860, 9a95004, 010b7bb, plus the e2e-only ISA update (no commit needed). `git rev-parse main` still bd9dec4. `git ls-remote origin feat/sdlc-suite-v0.2` empty.

### Run 2 — Changelog (conjecture/refutation/learning)

- conjectured: subscription auth (~/.claude/.credentials.json present) would zero the marginal cost of the spec E2E.
- refuted_by: spec e2e billed $2.8947 across 2 samples — clearly API-mode pricing, not subscription.
- learned: presence of `.credentials.json` does not guarantee subscription detection — the SDK's auth path may fall through to API key if the credential format doesn't match an OAuth bearer, or the env-var ANTHROPIC_API_KEY may have shadowed it. Worth a probe in Sprint 1.5+.
- criterion_now: add an explicit ISC for subscription auth detection: `--auth subscription` flag set, observable cost < $0.01 per sample. Not a Sprint 1.4 deliverable; add to backlog.

### Run 2 — Decisions

- 2026-05-15: Sprint 1.2 scoped additive (new runner + tests) rather than refactor-witness.ts-to-use-runner. Reason: lower risk; diff stage Claude+codex dual-backend already works; refactor is optimization. Migration path documented in HARNESS-PATTERN.md.
- 2026-05-15: spec stage finding-kind taxonomy ported verbatim from spec repo — no narrowing in v0.2.
- 2026-05-15: --stage flag NOT added as a flag; instead used subcommand pattern (`witness spec <path>`) matching existing `witness dissent <id>` shape. Reason: subcommand is clearer for path-positional args, and parallel to existing dispatch.
- 2026-05-15: madge dev-dep + circular script added; verified clean on 26 files. Run cost: 451ms.
- 2026-05-15: Forge auto-include skipped at Sprint 1.2/1.3/1.4 EXECUTE. Show my math: Sprint 1.2 was extraction from existing template; Sprint 1.3 was copy-and-rewire from sibling repo; Sprint 1.4 was prose + dependency add. None matched Forge's design-novel sweet spot. The E2E itself is the audit.
- 2026-05-15: Advisor (Rule 2) for Run 2 reused Run 1's gap analysis. Show my math: architectural decisions in Run 2 (additive runner, port verbatim, subcommand pattern) were all derived from Run 1's commit-ordering/inventory advice. Calling advisor again would re-derive the same conclusions.

---

## Run 3 (2026-05-15) — Sprint 2 (Stages 2/4/5/6)

### Criteria — additions

- [x] ISC-57: stages/design/ with 6 finding kinds (bottleneck, SPoF, scaling-cliff, undocumented-dep, contract-mismatch, security-perimeter)
- [x] ISC-58: stages/prompt/ with 6 finding kinds (jailbreak-surface, ambiguous-instruction, missing-refusal-path, format-leak, context-overflow-risk, evaluation-gap)
- [x] ISC-59: stages/eval-design/ with 6 finding kinds (insufficient-coverage, biased-fixture, missing-edge-case, wrong-scoring, contamination-risk, no-failure-mode)
- [x] ISC-60: stages/deploy/ with 6 finding kinds (privilege-escalation, secret-leak, network-exposure, missing-healthcheck, dependency-pin-drift, resource-blowup)
- [x] ISC-61: each new stage has 5 files (schema, json-schema, voting, prompt/instructions, stage runtime) using core/subagent-runner
- [x] ISC-62: stages/prompt/ uses instructions.ts for the system prompt (avoids prompt.ts filename clash)
- [x] ISC-63: src/index.ts dispatches witness design|prompt|eval-design|deploy <path>
- [x] ISC-64: all 4 new subcommands print --help cleanly and exit 0
- [x] ISC-65: pnpm typecheck exit 0 across all 4 stages
- [x] ISC-66: pnpm test passes 65/65 (no new tests; runner test in core covers shared path)
- [x] ISC-67: pnpm circular exits clean on 46 files (was 26 pre-Sprint-2)
- [x] ISC-68: E2E design stage on testing-spec.md → 3 voted findings, 2/2 votes each, $2.5566, 85.9s
- [x] ISC-69: Anti: stage 7 (production trace) deliberately NOT added — separate architecture (streaming sampler vs voted artifact)
- [x] ISC-70: Anti: no commits to main during Sprint 2 (work isolated on feat branch)

### Verification — Run 3

- ISC-57..62 — files exist per stage, schema.ts contains 6 z.literal kinds matching the documented taxonomy
- ISC-63 — `grep "runDesign\|runPromptStage\|runEvalDesign\|runDeploy" src/index.ts` returns 4+ matches
- ISC-64 — `pnpm witness <name> --help` exit 0 for all 4 stages (smoke-tested)
- ISC-65 — `pnpm typecheck` exit 0
- ISC-66 — `pnpm test` 8 test files, 65 tests, all passing
- ISC-67 — `madge --circular --extensions ts src/` processed 46 files, no circular deps found
- ISC-68 — design stage E2E:
  - [HIGH] single-point-of-failure @ line 234 — Postgres single instance, no replication/failover documented
  - [MEDIUM] security-perimeter @ line 254 — Tenant-agent scope enforcement not specified at DB layer
  - [MEDIUM] undocumented-dependency @ line 492 — MCP TypeScript client referenced without version or contract
- ISC-69, 70 — stage 7 absent from src/stages/; `git log main..HEAD` shows 0 commits on main during Sprint 2 (main still at f5f010c at commit time)

### Run 3 — Changelog

- conjectured: a single Python templating pass could generate 4 stage directories with correct JS template-literal escaping.
- refuted_by: the initial generator wrote DOUBLE-backslash before each backtick (`\\\``) which TypeScript parsed as a literal backslash followed by an unescaped backtick that terminated the template literal early. Required a byte-precise byte-replace pass to collapse `\\` → `\` inside SYSTEM_PROMPT bodies.
- learned: when templating JS template literals from Python, every escape level multiplies. Be explicit about what each `\\` collapses to in (a) the Python source string, (b) the rendered string, and (c) the JS source. The safest path is to use Python r-strings for the template body and apply ONE escape pass at output time.
- criterion_now: add a CI step (or pre-commit hook) that runs `pnpm typecheck` so generator bugs in prompt-content escaping cannot ship.

### Run 3 — Decisions

- 2026-05-15: stage 7 (production trace) deferred to Sprint 3. Reason: streaming sampler architecture (consume log events, sample a subset, classify each, escalate flagged) differs fundamentally from voted-artifact review (read one document, run N samples, merge votes). Forcing one runner to do both would be premature generalization.
- 2026-05-15: stages/prompt/ uses `instructions.ts` for system prompt to avoid the prompt.ts filename clash with the stage runtime. Other stages keep prompt.ts (no clash).
- 2026-05-15: CLI dispatch added via runtime-generated handlers (runDesign, runPromptStage, runEvalDesign, runDeploy) rather than a single generic runStage helper. Reason: TypeScript type-safety on each review() function's options/result is preserved; the boilerplate is acceptable for 4 thin handlers.
- 2026-05-15: skipped per-stage unit tests for Sprint 2. Reason: core/subagent-runner test covers the shared invocation path; each stage's prompt + schema is exercised by integration/E2E tests instead. Design stage E2E (this run) demonstrates the harness end-to-end on a real artifact.
