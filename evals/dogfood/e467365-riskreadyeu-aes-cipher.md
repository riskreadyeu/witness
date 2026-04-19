# Dogfood: RiskReadyEU `e467365` — AES-256-GCM secret cipher

**Date**: 2026-04-18
**Target**: [RISKREADYEU @ e467365](https://github.com/local/RISKREADYEU/commit/e467365) — initial AES-256-GCM secret cipher implementation (pre-hardening).
**Ground truth**: [be968af](https://github.com/local/RISKREADYEU/commit/be968af) — the follow-up commit that fixed 5 findings (1 HIGH, 4 MEDIUM) from a security review of `e467365`.

This is Oracle vs. a real security review done by a human on real, production-bound crypto code. Exactly the kind of commit Oracle is supposed to help with.

## Run

```
oracle --diff /tmp/riskready-e467365.patch --samples 5
  cwd: /tmp/oracle-dogfood-e467365   (git worktree at e467365)
  diff: 3,843 bytes, 2 files
  model: claude-sonnet-4-5-20250929
  budget: $1.00/sample, up to $5.00 total
```

**Cost**: $1.5882 total over 114 turns, 87.2s wall-clock. 5/5 samples parsed.

## Results

| # | Oracle finding | Oracle severity | Match to ground truth | Reviewer severity |
|---|----------------|-----------------|-----------------------|-------------------|
| 1 | Missing blob length validation before slicing auth tag | **MEDIUM** | → Finding 1 | **HIGH** |
| 2 | Missing key length validation in `decryptSecret` (asymmetric vs. encrypt) | MEDIUM | → Finding 2 | MEDIUM |
| 3 | Missing IV length validation on decrypt | MEDIUM | → Finding 4 | MEDIUM |

## Scorecard

- **Recall: 3 / 5 (60%)**
- **Precision: 3 / 3 (100%)** — no false positives, no noise.
- **Severity calibration: 1 miss** — the HIGH blob-truncation bug was downranked to MEDIUM. Concerning: the highest-impact finding is also the one Oracle under-ranked.
- **Cost per true positive**: $0.53.

## Misses — and what they tell us

### Missed: Finding 3 — error-text oracle (MEDIUM)

> All decrypt failures now throw this single typed `SecretDecryptError` with one opaque message (`"decryption failed"`) and preserve the underlying cause privately. Closes the error-text oracle.

Oracle saw the decrypt code and flagged input validation gaps, but never asked _"what does an attacker learn from the difference between these error messages?"_. That's a side-channel / information-disclosure bug — a distinct cognitive move from "does this input crash?".

This is the most sophisticated finding in the review, and arguably the one where a human cryptographer earns their keep. Oracle did not attempt this analysis in any of the 5 samples.

### Missed: Finding 5 — canonical base64 (MEDIUM)

> Add `decodeStrictBase64` helper that enforces canonical base64 (`/^[A-Za-z0-9+/]+={0,2}$/`) on both inputs. Closes silent normalization on malformed/truncated envelopes.

A parser-differential attack: Node's base64 decoder silently tolerates garbage characters, so two different byte sequences can decode to the same plaintext envelope. Oracle needs to know _base64 parsers vary_ and _Node's default is lenient_ — domain knowledge that didn't surface in any sample.

## What this run tells us about Oracle

**Good signals.**
- Zero false positives on real code. That's the thing that kills code-review tools in practice.
- The three findings it did surface are _actionable_, _correctly scoped_, and _written in a way a reviewer can take to a PR_ ("validation should be symmetric", "matches the pattern in encryptSecret line 14-15").
- `5/5 samples parsed` on a real 13KB diff at the new default budget — budget semantics fix was the right call.
- Multi-sample voting plus `minVotes=2` correctly suppressed spurious single-sample findings.

**Real weaknesses.**
- **Severity calibration is off on the highest-impact finding.** A product that rates the HIGH bug as MEDIUM teaches users to trust our severities less.
- **Misses the "attacker model" class of bugs entirely.** Side-channels, parser differentials, error-text oracles, timing leaks — Oracle stays in the "does bad input crash this" frame. The system prompt does not explicitly direct the model to adopt an adversarial mental model, and the missing-findings pattern strongly suggests it should.
- **The harder findings are exactly the findings that matter.** If Oracle only catches the "obviously missing validation" class, a human reviewer still has to do the actual crypto review. The value case is weaker.

## Action items

1. **Add `security-adversarial` as a first-class mode or prompt appendix.** Teach the model to enumerate _what an attacker can vary in the input_ (length, encoding, repeat calls for timing, error text) before scoring findings. Candidate system-prompt addition:
   > _For any function accepting untrusted input, enumerate: (a) what bytes the attacker controls; (b) what distinguishable outputs the attacker observes (return value, error text, time to fail); (c) whether (a) → (b) leaks anything the attacker shouldn't know. This is the side-channel / oracle class of bugs and is frequently missed by pure validation-focused review._

2. **Calibrate severity upward for data-integrity / crypto-primitive bugs.** Missing auth-tag-length validation in an AES-GCM decrypt is not "medium severity" — it removes the integrity guarantee the primitive is supposed to provide. Add a rubric excerpt.

3. **Add `evals/fixtures/006-crypto-error-oracle/` as a regression fixture.** Smallest-possible synthetic version: a decrypt function that throws three distinguishable errors for three distinguishable failure modes. Expected finding: "error messages leak which check failed".

4. **Add `evals/fixtures/007-base64-parser-differential/` if we can keep it below the "trivia" bar.** Risk: this is domain-specific enough that it may need to live as a check in a dedicated crypto lint layer rather than as a baseline eval.

## What I am NOT concluding from this

- Oracle is not "ready to replace a human security reviewer on crypto code". One diff is one data point. A 60% recall on a single 5-finding commit tells us we have real gaps, not a statistic.
- Oracle is not "bad at security". The three findings it did surface would have caught the bug in a PR. The question is whether the _missed_ findings would have shipped, and the honest answer is: on this diff, yes.
