# Harness pattern

> A note to my future self at the moment of "should this be a skill or a CLI?"

## Thesis

A skill that produces **structured judgment about code or artifacts** wants to be a CLI, not a markdown file. Witness is the canonical example. The pattern generalizes.

## Shape

```
short prompt        ← definitions, not tutorials
+ tool restriction  ← read-only / scoped / sandboxed
+ JSON schema       ← constrained output, validated
+ N-sample voting   ← when calibration matters (skip if expensive)
+ eval harness      ← so you can tell when the model improves past your scaffolding
+ feedback log      ← so you tune with data, not vibes
= one CLI binary
```

Witness is this exact shape. See:

- prompt: [`src/prompt.ts`](src/prompt.ts) — ~250 lines, mostly definitions
- schema: [`src/schema.ts`](src/schema.ts) — discriminated union, 7 `kind` values, refined
- voting: [`src/voting.ts`](src/voting.ts) — stable id from `(file, startLine, endLine, kind)`
- evals: [`evals/`](evals/) — fixture pool with expected findings
- dissent: [`src/dissent.ts`](src/dissent.ts) — JSONL feedback loop

## Conversion test

**A skill should be CLI-shaped if its output could be a JSON object with the same fields every time.**

If you can write a Zod schema for what it produces, it wants to be a CLI.

## When the pattern fits

- **Code review.** kind/severity/file/line/why. Witness.
- **Design review.** category/severity/screenshot/fix-hint.
- **Plan review.** ratings + issues + recommended-changes.
- **Code-health dashboard.** score + dimensions[].
- **QA bug report.** findings[] + repro steps + screenshots.
- **Security audit.** findings[] + threat model + remediation.
- **Debugging investigation.** rootCause + evidence[] + hypotheses[].

What these share: structured judgment over an artifact, repeatable shape, model is doing pattern recognition not creative writing.

## When the pattern does NOT fit

- **Procedural skills** (`/ship`, `/land-and-deploy`, `/loop`). State machines and workflows. Those are CLI tools too, but they're not Witness-shaped — they're orchestrators. No schema, no voting, no eval. Different beast.
- **Persona / framing skills** (`boris-cherny`, `karpathy-ai-partner`). Output is conversational. Compress the prose body, don't restructure into a CLI.
- **Knowledge skills** (`riskready-expert`, `tva-accounting`). Body carries facts the model doesn't have. The verbosity is the point — those facts can't compress to one sentence without hallucination.

## Minimum implementation checklist

If you're about to write a markdown skill and the conversion test passes, do this instead:

1. **Define the output schema first.** Zod, discriminated union if there's a `kind`. The schema is the contract; everything else is plumbing.
2. **Write the prompt as definitions, not tutorials.** One sentence per output type. Trust the model to map cases to definitions. The Bitter Lesson — long prompts get eaten by the next model.
3. **Restrict tools to the minimum.** Read-only at minimum (Read/Grep/Glob via SDK, or `--sandbox read-only` via codex). Add Bash only if the task literally needs to run something (debugging).
4. **Skip voting until you need it.** N-sample voting is a 5x cost multiplier and it's a temporary ladder. Add it when single-sample is too noisy and you can prove it via the eval harness. Don't add it speculatively.
5. **Build the eval harness from day one, even with 3 fixtures.** You will regret skipping this. The fixture count grows; the calibration moment will come; it's cheaper to start small than to backfill.
6. **Add a feedback log.** Even single-slot, append-only JSONL. It's the only honest source of "did this finding matter" data and it auto-grows your fixture pool as a side effect.
7. **The skill becomes a 5-line doorbell.** It runs the CLI, presents the output, lets the parent agent react. Don't put logic in the markdown.

## What you gain over a markdown skill

- **Trust separation.** CLI runs in its own SDK session. Reviewer can't be context-poisoned by the agent that wrote the code.
- **Diversity of failure modes.** Different CLIs can target different backends. Code-review on Claude, design-review on Codex — same workflow we proved on bonocr.
- **Eval-able.** Schema-validated output runs against fixtures. You can measure whether harness-CLI got better or worse on the next model. Markdown skills can't be measured.
- **Composable.** `git diff | code-review-cli | design-review-cli | security-cli`. Each independent, each emits structured JSON.
- **Versionable.** Schema in TypeScript, prompt in TypeScript, behavior testable. Markdown skills are unversioned text that drifts.

## The forward bet

In 12-18 months, harness CLIs and skills will look very different from today.

- Persona/framing skill bodies will have compressed dramatically (Opus 6 doesn't need 5K words to play Boris Cherny).
- Knowledge skills compress as the new model picks up more in training.
- Harness skills mostly disappear from `~/.claude/skills/` and reappear as small CLIs in `/usr/local/bin` or per-project tools, each with its own schema and eval pool.

The skill system becomes a thin layer of triggers and doorbells. The judgment lives in CLIs.

## When to write the next one

Don't speculatively. Wait for the moment of "I keep wanting Claude Code / Codex to do this structured-judgment thing and I keep tweaking the prompt." That's the signal. At that point, the schema is already half-written in your head — extract it, build the CLI, and let the markdown skill thin out.

The pattern is cheap to apply once you see it. The waste is rebuilding the pattern from scratch each time inside markdown.
