# Dogfood results

Curated write-ups from running Witness against real-world commits.

Unlike `evals/fixtures/` (synthetic, scored, regression-gated) and
`evals/results/` (ephemeral raw JSON from `runner.ts`, gitignored), the
files here are **product evidence** — what Witness actually said on real
code, what it got right, what it got wrong, and what follow-up actions
fell out of the exercise.

**Redaction rule**: every file committed to this directory has been
manually checked to ensure it does not leak proprietary source from the
target repo. We cite line numbers, function names already visible in
public security-advisory-style reporting, and our own analysis — not the
implementation. If in doubt, keep it private (`evals/fixtures-private/`).

## Index

- [`e467365-riskreadyeu-aes-cipher.md`](./e467365-riskreadyeu-aes-cipher.md) — AES-256-GCM secret cipher initial implementation vs. a 5-finding security review. Recall 3/5, precision 3/3, one severity miscalibration.
