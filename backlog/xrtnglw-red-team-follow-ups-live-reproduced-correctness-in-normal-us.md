---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/review-dispatch.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7604 (head bba38d7bb)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7604 (reviewed head `bba38d7bb35011ebb48c2498b47a5dac5b6e4700`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/review-dispatch.mjs:701` — (failing-input, degraded) Session mode raises the supervisor to Opus but leaves the actual reviewers on Sonnet.
   - Scenario: Dispatch a session-mode review for a PR containing a trusted whole-line requires-review marker. The supervisor launches with --model opus and logs a successful floor, but its instantiated brief invokes we:review-loop-cli.mjs without --model=opus. The loop therefore retains we:review-pr.mjs's JUDGE_MODEL='sonnet' for its jurors. Carry the floored model into the review-loop command so the reviewers themselves use Opus.
   - Class: live-reproduced (basis: Read-only probes exercised production dispatchReview with the real brief and a recording spawn, observing an Opus supervisor and an unpinned loop command. A separate production createDefaultJudge probe with a recording provider confirmed that the resulting unoverridden juror request uses Sonnet. No external agents were launched.)
   - Also class: correctness-in-normal-use
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
