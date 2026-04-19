# Witness -- Product Requirements Document

> The AI that refuses to touch your files.

**Status:** Draft v0.1
**Author:** [you]
**Last updated:** 2026-04-18

---

## One-line pitch

**Witness is an AI pair programmer with no hands.** It reads your code, your diff, your repo -- and streams structured recommendations. It never writes, never edits, never commits. You stay in the driver's seat.

---

## Why this exists

Every AI coding agent on the market right now is sprinting toward *more* agency. Cursor agent mode, Claude Code, Devin, Codex, OpenHands -- they all want to touch your files, run your commands, ship your code. That's genuinely useful. It's also how people lose databases, rewrite 400 files overnight, and burn $800 in a single runaway loop.

There's a quietly-growing counter-wave: *agent fatigue*. Users want the intelligence without the exuberance. They want a model that thinks hard, sees deeply, and **tells them what it sees** -- then gets out of the way.

Witness is that product.

## Philosophical foundations

This isn't vibes -- there's 25 years of alignment literature behind this shape.

- **Nick Bostrom** (*Superintelligence*, 2014) distinguishes three AI archetypes: **Oracle** (answers questions), **Genie** (executes commands), **Sovereign** (pursues open-ended goals). Witness is an Oracle in this sense, and the Oracle archetype is the safest of the three by construction.
- **Yoshua Bengio** (2024-2025) advocates "Scientist AI" -- models that predict and explain but don't act.
- **Norbert Wiener** (*The Human Use of Human Beings*, 1950): *"We had better be quite sure that the purpose put into the machine is the purpose which we really desire."* Witness solves this by never *executing* on purpose -- only describing it.

The product ships with intellectual credibility. That credibility becomes the marketing.

---

## Target users

### Primary: Senior engineers who use AI agents daily

- Has 5-20 Claude Code / Cursor / Codex sessions open regularly.
- Has been burned at least once by an agent making changes they didn't want.
- Values *code review* more than *code generation*.
- Will pay for quality over quantity.

### Secondary: Teams with regulated or high-stakes codebases

- Finance, healthcare, security-sensitive.
- Cannot allow autonomous write access to their repos.
- Need AI benefit *without* AI blast radius.

### Not our user (yet)

- Indie hackers who want "just ship it." They want Cursor, not Witness.
- Teams that trust agents fully and want more automation. Paperclip is their product.

---

## What Witness does (MVP)

Witness watches a git diff (or a file, or a repo) and produces a stream of **structured recommendations**:

- `bug` -- a likely defect at a specific location, with a preview diff.
- `refactor` -- duplication, complexity, or convention violations, with a preview.
- `convention` -- project-style violations.
- `architectural` -- higher-level concerns (module boundaries, layering).

Each recommendation carries:
- A **confidence score** (0-1), calibrated via multi-sample voting -- not LLM self-report.
- A **where** (file path + line).
- A **why** (one-line human explanation).
- A **preview diff** (if applicable) -- shown, **never applied**.

The user can **copy** a preview diff to the clipboard. The user *cannot* tell Witness to apply it. That is the entire product constraint. Cross that line and this becomes Cursor.

---

## What Witness explicitly does not do

**The box is the product, not scaffolding.** Most AI products constrain the model *hoping* to improve output quality -- which The Bitter Lesson eats. Witness's constraint is categorically different: it's a feature the user is buying. Blast radius, not quality. This matters because when the next model ships and someone asks "can we safely turn on the apply button now?", the answer is no -- not because the old model was unsafe to apply, but because the user wanted to stay in the driver's seat. Model quality doesn't change that.

- **No write tools.** No `Edit`, no `Write`, no `Bash` (write subset), no commits, no pushes, no branch creation.
- **No apply button.** Not now, not later, not "just as a feature flag." This is the brand.
- **No general chat.** Witness is not a conversational assistant -- it streams structured recommendations. *Recommendation-local follow-up* ("why did you flag this?") is a feedback-loop feature planned for v0.2 and is different from chat. The boundary: users interrogate specific findings; they don't converse with Witness.
- **No config.** Zero config, like Prettier. The model figures out what matters.
- **No team features (MVP).** Solo dev first. Team surface ships later if the solo product works.
- **No vector DB / RAG.** Agentic glob/grep beats vector search at current model sizes. Don't build it.
- **No network egress beyond Anthropic's API.** Witness calls `api.anthropic.com`. That's it. No `WebFetch` to arbitrary URLs -- that's a prompt-injection exfil channel waiting to happen. (Domain-allowlisted fetch may return in v0.2 if users need it.)

---

## Features (prioritized)

### v0.1 -- MVP (ships in one weekend)

| Feature | Description | Why |
|---|---|---|
| `witness .` CLI | Runs against current git diff, outputs color-coded recommendations | Terminal is the only form factor that keeps up with model iteration |
| Read-only tool spec | Read, Glob, Grep, Bash (read-only subset) | The entire "no hands" guarantee -- minimal surface, no network-writing tools |
| Multi-sample voting | Each recommendation pass runs 5x at temp 0.7, agreement = confidence | Real calibration, not LLM confidence theater |
| Structured JSON output | Union-type recommendations, pretty-printed with color | Type system becomes documentation |
| Confidence filter | `witness . --min-confidence 0.8` | Users control signal-to-noise |
| Dissent logging | Dismissed + accepted recommendations written to `.witness/*.jsonl` | Telemetry is how the product learns; 20 lines of code; ship it day one |
| "No hands" guarantee | Prominent in CLI output, blog post, README | The thesis IS the marketing |

### v0.2 -- First polish pass

- **Preview-diff clipboard.** Key binding to copy a suggested diff to the clipboard. Cannot apply.
- **Recommendation-local follow-up.** Tap `?` on any finding, Witness expands its reasoning in one more paragraph. Not chat -- a feedback loop bounded to the specific finding.
- **Sandbox enforcement.** OS-level read-only filesystem mount (Docker `--read-only` first; platform-native later). Belt-and-suspenders on top of the no-write-tools runtime -- added *only* when there's a concrete threat model motivating it.
- **Domain-allowlisted fetch (maybe).** If users demand it, a tiny `WebFetch` that only hits a user-configured allowlist. Default empty.

### v0.3 -- Daemon mode

- **`witness watch`** -- filesystem observer. Streams new recommendations as you code.
- **Editor sidebar** (VS Code extension). Gutter marks, hover previews. **Copy** only.
- **Second-opinion mode.** Runs alongside Claude Code / Cursor, surfaces only the disagreements.

### v0.4 -- Adversarial audits

- **Panel of witnesses.** A second Witness with an opposing prior audits the first Witness's recommendations. Disagreement surfaces for human attention.
- Addresses Bostrom's **deceptive-oracle problem** -- an oracle optimizing for "being listened to" might strategically distort. The panel is the corrective.
- Ships as a premium feature for regulated customers.

---

## Success metrics

### Leading indicators (first 30 days)

- **GitHub stars** -- vanity, but real signal for OSS.
- **HN front page** for the launch blog post.
- **Installs / `npx witness` runs** -- weekly.

### Real metrics (first 90 days)

- **Recommendation acceptance rate** -- % of surfaced recommendations that users copy.
- **Dissent log entries per session** -- low is bad (nobody ignores it = people aren't reading it).
- **Recall on benchmark** -- does Witness catch the bugs in our held-out eval set? (Target: ≥70% recall at 0.8+ confidence on the MVP eval.)
- **Retention** -- DAU/WAU ratio over time.

### Anti-metrics (things that would tempt us in the wrong direction)

- Apply-button requests. We say no. Forever.
- "Make it faster" requests that trade off advice quality. Witness uses the slowest, smartest model -- that's intentional.

---

## Go-to-market

### Launch sequence

1. **Day -7**: Eval harness. 20-30 real diffs with known issues. Witness hits ≥70% recall.
2. **Day -3**: Blog post draft: *"Against Agent Mode."* 1,500 words. Position Witness as the serious counter-thesis.
3. **Day 0**:
   - Blog post goes live.
   - GitHub repo public.
   - 60-second demo video (side-by-side: Claude Code vs Witness on the same diff).
   - Post to HN, Twitter, r/programming.
4. **Day +7**: First retrospective post -- "what I learned from 1,000 Witness runs."

### Positioning

- **"The AI that refuses to do anything."**
- **"Think of it as the Scientist, not the Intern."**
- **"Paperclip maximizes. Witness observes."**

### Distribution

- Open source from day zero. MIT license.
- `npx witness` -- zero install friction.
- Pricing: free OSS CLI. Paid hosted service later, for teams and adversarial audits.

---

## Non-goals (say no loudly)

- **Being Cursor.** We are the opposite of Cursor. That's the whole point.
- **Supporting every model.** Start Claude-only. Fork if you want OpenAI.
- **Being a general chatbot.** Witness is a specialist: it reads code and gives structured advice.
- **Enterprise RBAC on day one.** Solo dev product first.
- **Code generation from scratch.** Witness comments on *existing* code, doesn't write greenfield.

---

## Open questions

1. **Quality bar.** Witness's advice must be *noticeably* better than what the user would spot alone, or it's just an annoying linter. The product rises or falls on prompt engineering + evals. How much time do we invest in this before the launch? (Proposal: **75% of build time.** Coding is largely solved; eval design is not. Under-invest here and the rest doesn't matter.)
2. **Deployment model.** Local CLI forever, or eventually hosted? Hosted buys us telemetry (and calibration data) but breaks the "nothing leaves your machine" story that safety-conscious users love. (Proposal: local-first; hosted is opt-in phase 3.)
3. **Monetization.** OSS + paid hosted? OSS + paid enterprise audit features? Sponsorware?
4. **Name.** (Resolved 2026-04-19.) The project was initially called *Oracle*, which collided with `steipete/oracle` (1.9k stars, askoracle.dev) and with Oracle Corp's trademark. Renamed to *Witness* -- "one who sees but does not act." Names the permanent property of the product (read-only), sidesteps the collisions, and still carries the Bostrom Oracle archetype via the PRD framing.
5. **The 6-months-out thesis.** As model write-quality improves, does the read-only constraint remain a user benefit or become a niche? Stress-test: in a world where Claude 5 writes the median diff better than the median engineer, Witness's value shifts from *"safer than agents"* to *"adversarial audit for a world where everyone uses agents."* Implication: the panel-of-witnesses feature (v0.4) may be more central than the roadmap currently treats it. Consider elevating.

---

## Appendix: related prior art

- **Paperclip** (paperclipai/paperclip, 2026) -- orchestration for "zero-human companies." Maximalist. Witness is the counter.
- **Cursor agent mode** / **Claude Code** / **Codex** / **Devin** / **OpenHands** -- all on the "more agency" curve.
- **AI Safety via Debate** (Christiano et al., 2018) -- relevant to the panel-of-witnesses feature in v0.4.
- **Bengio's "Scientist AI"** (2024-2025) -- explicit philosophical parent.
- **Asimov's Three Laws** -- spiritual cousin. Witness's first rule is "do not touch."
