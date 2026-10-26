---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/ruling-ledger.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5924 (head 50608b23f)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5924 (reviewed head `50608b23f34eb5a818017813fbf50289180e95a2`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/ruling-ledger.mjs:290` — (failing-input, degraded) Append-only re-check markers are ignored, causing false ignored-ruling disputes.
   - Scenario: Post a block for finding K on H1, then an evidenced not-real ruling for K on H2. On H3, post an attempted, unruled record, followed by its cumulative snapshot with rechecks:[{key:K,status:'needs re-check on live head',fromHead:H2,head:H3}]. This is the supported format emitted by we:review-pr-io.mjs for existing records. A Node probe confirmed malformed:false, but ignoredRulings returned a match with misses:2. Encoding the same marker inline on the referral returned null. The new code reads only f.recheck and misses record.rechecks. Both formats should leave K pending without counting an ignored
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/ruling-ledger.mjs:299` — (edge-case, degraded) A reused ruling ID on an unrelated record invalidates the source-head clearance.
   - Scenario: In thread order, post an unrelated finding's evidenced not-real ruling with id:'r0' on H0; a block for K on H1; an evidenced not-real ruling for K with id:'r0' on H2; then an unruled K on H3 with inline recheck.fromHead:H2. Ruling IDs may repeat across records; validation requires uniqueness only within each record. A Node probe confirmed all records were readable, yet ignoredRulings returned misses:2. Removing the unrelated H0 record returned null. The newly invoked source-head notRealClearanceAt finds the first not-real with that ID anywhere in the thread, assigning H0's position to H2's cle
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
