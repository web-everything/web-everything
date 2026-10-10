---
bornAs: xpq2tkt
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/advisory-label-sweep.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#4826 (head f0f5849cb)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#4826 (reviewed head `f0f5849cbef1d8ef70918af40417bbdfb802d676`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/advisory-label-sweep.mjs:112` — (edge-case, degraded) Separate metadata and comment reads can remove a valid current-head acceptance label.
   - Scenario: Reproduced with a read-only Node probe through defaultReadPr and sweepAdvisoryLabels using injected IO. A PR has 100 comments, head A, and advisory:accepted, so it is nominated. The metadata read returns head A. During comment pagination, the PR advances to B and receives a trusted accept advisory for B, with advisory:accepted present. The comment read returns that new advisory, but defaultReadPr combines it with head A. The sweep consequently removes advisory:accepted even though the latest advisory covers the actual head B. The probe confirmed that planForPr on the actual state returns an em
   - Claude's re-check: defaultReadPr reads head/labels via 'gh pr view', then separately paginates comments, with no revalidation. If the head moves to B and a B advisory lands in between, planForPr sees head A with newest advisory naming B, so it plans removal of a label that is valid for the real head. The sweep then writes that removal. The next tick would likely repair it, but the wrong write still happens.

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
