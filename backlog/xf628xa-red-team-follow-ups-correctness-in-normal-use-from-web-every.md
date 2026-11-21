---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/round-judge.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7237 (head 0a9c06897)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7237 (reviewed head `0a9c06897b400d27c9bc8451468018b05a8c1c28`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/round-judge.mjs:153` — (failing-input, degraded) Production reviewer verdicts still cannot settle a same-head hold
   - Scenario: Use live head b repeated 40 times, a trusted referral hold naming its nine-character prefix, and a later trusted changes-requested comment produced by review-pr. renderVerdictWriteUp places the reviewed SHA in its Net basis footer; buildVerdictComment adds no standalone head field for changes. With state at-round-limit, detectRoundCap still returns referral-hold, so the sweep skips judging and parks on trigger-mismatch. It should recognize the production verdict's bound live head and return review-cap. The added tests instead inject a standalone head field that this production path does not em
   - Class: correctness-in-normal-use (basis: Confirmed the production renderers' output format by source inspection. Executed the actual detector functions in memory with unrelated gate/grant parsers stubbed: the production-format footer retained referral-hold; adding the tests' standalone head field switched it to review-cap. Full imports were unavailable because markdown-it is missing.)
   - Claude's re-check: demonstrated break

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
