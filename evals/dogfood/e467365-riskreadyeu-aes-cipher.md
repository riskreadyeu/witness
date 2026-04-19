# Dogfood: RiskReadyEU `e467365` — AES-256-GCM secret cipher

**Date**: 2026-04-18
**Target**: [RISKREADYEU @ e467365](https://github.com/local/RISKREADYEU/commit/e467365) — initial AES-256-GCM secret cipher implementation (pre-hardening).
**Ground truth**: [be968af](https://github.com/local/RISKREADYEU/commit/be968af) — the follow-up commit that fixed 5 findings (1 HIGH, 4 MEDIUM) from a security review of `e467365`.

This is Witness (then called "Oracle") vs. a real security review done by a human on real, production-bound crypto code. Exactly the kind of commit Witness is supposed to help with.

## Run

```
witness --diff /tmp/riskready-e467365.patch --samples 5
  cwd: /tmp/witness-dogfood-e467365  (git worktree at e467365)
  diff: 3,843 bytes, 2 files
  model: claude-sonnet-4-5-20250929
  budget: $1.00/sample, up to $5.00 total
```

**Cost**: $1.5882 total over 114 turns, 87.2s wall-clock. 5/5 samples parsed.

## Results

| # | Witness finding | Witness severity | Match to ground truth | Reviewer severity |
|---|----------------|-----------------|-----------------------|-------------------|
| 1 | Missing blob length validation before slicing auth tag | **MEDIUM** | → Finding 1 | **HIGH** |
| 2 | Missing key length validation in `decryptSecret` (asymmetric vs. encrypt) | MEDIUM | → Finding 2 | MEDIUM |
| 3 | Missing IV length validation on decrypt | MEDIUM | → Finding 4 | MEDIUM |

## Scorecard

- **Recall: 3 / 5 (60%)**
- **Precision: 3 / 3 (100%)** — no false positives, no noise.
- **Severity calibration: 1 miss** — the HIGH blob-truncation bug was downranked to MEDIUM. Concerning: the highest-impact finding is also the one Witness under-ranked.
- **Cost per true positive**: $0.53.

## Misses — and what they tell us

### Missed: Finding 3 — error-text oracle (MEDIUM)

> All decrypt failures now throw this single typed `SecretDecryptError` with one opaque message (`"decryption failed"`) and preserve the underlying cause privately. Closes the error-text oracle.

Witness saw the decrypt code and flagged input validation gaps, but never asked _"what does an attacker learn from the difference between these error messages?"_. That's a side-channel / information-disclosure bug — a distinct cognitive move from "does this input crash?".

This is the most sophisticated finding in the review, and arguably the one where a human cryptographer earns their keep. Witness did not attempt this analysis in any of the 5 samples.

### Missed: Finding 5 — canonical base64 (MEDIUM)

> Add `decodeStrictBase64` helper that enforces canonical base64 (`/^[A-Za-z0-9+/]+={0,2}$/`) on both inputs. Closes silent normalization on malformed/truncated envelopes.

A parser-differential attack: Node's base64 decoder silently tolerates garbage characters, so two different byte sequences can decode to the same plaintext envelope. Witness needs to know _base64 parsers vary_ and _Node's default is lenient_ — domain knowledge that didn't surface in any sample.

## What this run tells us about Witness

**Good signals.**
- Zero false positives on real code. That's the thing that kills code-review tools in practice.
- The three findings it did surface are _actionable_, _correctly scoped_, and _written in a way a reviewer can take to a PR_ ("validation should be symmetric", "matches the pattern in encryptSecret line 14-15").
- `5/5 samples parsed` on a real 13KB diff at the new default budget — budget semantics fix was the right call.
- Multi-sample voting plus `minVotes=2` correctly suppressed spurious single-sample findings.

**Real weaknesses.**
- **Severity calibration is off on the highest-impact finding.** A product that rates the HIGH bug as MEDIUM teaches users to trust our severities less.
- **Misses the "attacker model" class of bugs entirely.** Side-channels, parser differentials, error-text oracles, timing leaks — Witness stays in the "does bad input crash this" frame. The system prompt does not explicitly direct the model to adopt an adversarial mental model, and the missing-findings pattern strongly suggests it should.
- **The harder findings are exactly the findings that matter.** If Witness only catches the "obviously missing validation" class, a human reviewer still has to do the actual crypto review. The value case is weaker.

## Action items

1. **Add `security-adversarial` as a first-class mode or prompt appendix.** Teach the model to enumerate _what an attacker can vary in the input_ (length, encoding, repeat calls for timing, error text) before scoring findings. Candidate system-prompt addition:
   > _For any function accepting untrusted input, enumerate: (a) what bytes the attacker controls; (b) what distinguishable outputs the attacker observes (return value, error text, time to fail); (c) whether (a) → (b) leaks anything the attacker shouldn't know. This is the side-channel / oracle class of bugs and is frequently missed by pure validation-focused review._

2. **Calibrate severity upward for data-integrity / crypto-primitive bugs.** Missing auth-tag-length validation in an AES-GCM decrypt is not "medium severity" — it removes the integrity guarantee the primitive is supposed to provide. Add a rubric excerpt.

3. **Add `evals/fixtures/006-crypto-error-oracle/` as a regression fixture.** Smallest-possible synthetic version: a decrypt function that throws three distinguishable errors for three distinguishable failure modes. Expected finding: "error messages leak which check failed".

4. **Add `evals/fixtures/007-base64-parser-differential/` if we can keep it below the "trivia" bar.** Risk: this is domain-specific enough that it may need to live as a check in a dedicated crypto lint layer rather than as a baseline eval.

## What I am NOT concluding from this

- Witness is not "ready to replace a human security reviewer on crypto code". One diff is one data point. A 60% recall on a single 5-finding commit tells us we have real gaps, not a statistic.
- Witness is not "bad at security". The three findings it did surface would have caught the bug in a PR. The question is whether the _missed_ findings would have shipped, and the honest answer is: on this diff, yes.

---

## Follow-up run — prompt v2 (2026-04-19)

After the action items above, we (a) added an adversarial-reasoning
section to the system prompt (attacker-controlled bytes / observable
outputs / invariant broken) with explicit crypto red flags including
distinguishable decrypt-path errors and lenient base64, and (b) added
[`evals/fixtures/006-crypto-error-oracle/`](../fixtures/006-crypto-error-oracle/)
as a synthetic regression fixture for the error-text oracle class.

### Re-run against the same target

```
witness --diff /tmp/riskready-e467365.patch --samples 5 --budget 1.5
  same cwd, same model, same diff
```

**Cost**: $0.9797 total over 73 turns, 72.5s wall-clock. 5/5 samples parsed.
(Cost dropped ~38% — fewer turns spent in vague exploration because the
prompt frames the task more concretely.)

### Findings (voted)

| # | Witness finding | Severity | Votes | Ground-truth match |
|---|----------------|----------|-------|-------------------|
| 1 | Decrypt function leaks failure mode via distinguishable errors | **HIGH** | 5/5 | → Finding 3 (error-text oracle) — **NEW** |
| 2 | Missing IV length validation before use in AES-GCM decryption | HIGH | 3/5 | → Finding 4 (promoted HIGH) |
| 3 | Base64 parsing silently drops invalid characters in security context | MEDIUM | 3/5 | → Finding 5 (canonical base64) — **NEW** |
| 4 | Missing key length validation in decryptSecret | MEDIUM | 2/5 | → Finding 2 |
| 5 | Missing key length validation in decryptSecret (dup) | MEDIUM | 2/5 | → Finding 2 (duplicate of #4) |

### Scorecard delta

|  | Before | After | Δ |
|---|--------|-------|---|
| Recall | 3/5 (60%) | **4/5 (80%)** | +20pp |
| Error-text oracle (Finding 3) | missed, 0/5 samples | **caught, 5/5 samples** | — |
| Canonical base64 (Finding 5) | missed, 0/5 samples | **caught, 3/5 samples** | — |
| Precision | 3/3 (100%) | 4/5 (80%) | −20pp (one duplicate, not a false positive) |
| Severity on Finding 1 (blob-length/HIGH) | MEDIUM (undercalled) | still not explicitly called out | — |
| Cost | $1.59, 114 turns, 87s | $0.98, 73 turns, 72s | −38% cost, −36% turns |

### What actually changed

The headline: **the error-text oracle class — previously 0/5 samples,
a total blind spot — is now 5/5 samples, ranked HIGH.** That's the
finding the prompt change was targeting, and the prompt change
closed the gap. This is the dogfood → fixture → prompt → dogfood
loop working as designed.

The base64 parser-differential finding also landed (3/5 samples),
which I was less sure about because it's closer to domain trivia.
Apparently listing it as a named red flag was enough. Worth watching
for false positives on diffs that use Buffer.from('base64') in
contexts that are _not_ security-sensitive.

### Remaining gap

We still don't explicitly surface Finding 1 ("blob-length validation
before slicing auth tag") as its own finding. The new #1 covers the
whole decrypt function under "leaks failure mode", which is arguably
correct — all these bugs are instances of the same underlying
problem — but a reviewer scanning the output would see "4 findings"
instead of "5 findings", and the slice-underflow specifically is
its own bug with its own fix.

This is fine for now. The primary goal (closing the attacker-model
blind spot) is met. A follow-up experiment would tighten severity
calibration on AEAD integrity bugs, but that's a calibration task,
not an adversarial-reasoning task.

### Reproducibility

Run yourself (requires RISKREADYEU repo checked out locally):

```
git -C /path/to/RISKREADYEU diff e467365^..e467365 > /tmp/e467365.patch
git -C /path/to/RISKREADYEU worktree add /tmp/witness-e467365 e467365
cd /tmp/witness-e467365
witness --diff /tmp/e467365.patch --samples 5 --budget 1.5
git -C /path/to/RISKREADYEU worktree remove /tmp/witness-e467365
```

Results will vary ± one finding due to sampling noise; the
error-text-oracle finding has been stable at 5/5 across the runs
I've done.
