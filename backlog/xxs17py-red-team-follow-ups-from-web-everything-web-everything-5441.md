---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/review-pr.mjs"]
dateOpened: "2026-10-16"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5441 (head de799ad4a)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5441 (reviewed head `de799ad4a9bd487848d98719645bcd445a62f4dd`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/review-pr.mjs:1957` — (edge-case, degraded) Already-reduced historical runs publish no diversity-shortfall warning.
   - Scenario: Resume a pre-change, two-Claude-seat run already parked at confirm, using the default minimum of 1. Its saved reduce/referralVerdict/verdict objects lack nonClaudeSeatShortfall. Roster reconstruction preserves the two seats, but confirmation never reruns reduction or adds the missing diversity metadata, so this conditional silently omits the warning. An in-memory probe through advanceReviewPrToWriteUp with a captured WRITE_UP sink advanced confirm→record and staged one body containing no NON-CLAUDE SEAT SHORTFALL despite zero non-Claude answers. Historical resumes should retain their roster wh
   - Claude's re-check: The diff makes renderVerdictWriteUp and renderAdvisoryNote read 'verdict.nonClaudeSeatShortfall' straight off the saved verdict, and only the new reduce step sets it. A pre-change run already reduced and parked at confirm has no such field, so the warning is omitted. The docs promise saved runs get 'the same explicit shortfall reporting', and nothing in the diff derives it for them.

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
