---
bornAs: x1ty8wp
kind: story
size: 3
status: open
related: ["4392"]
scope: ["we:scripts/operations/needs-you-feed.mjs", "we:scripts/conveyor/reconcile-note-comment.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Feed dedupe key repo#pr@head:kind collapses two distinct asks on the same PR and head into one NEEDS-YOU event

Flow-sim gap R8b-G8, class K15 (detector or report false negative). Failing input: Same PR and head with two different open asks that map to the same feed kind: e.g. a round-cap-exhausted note and a ci-heal-exhausted note (both -> at-round-limit; daemon publish at we:reconcile-fix-dispatch-daemon.mjs:434-437), or a ruling-ledger row plus a needsPerson note of an unmatched kind (both 'ruling-needed'; here G2 a… Cited: we:scripts/operations/needs-you-feed.mjs:83, we:scripts/operations/needs-you-feed.mjs:134, we:scripts/operations/needs-you-feed.mjs:158, we:scripts/conveyor/reconcile-note-comment.mjs:96-110. Soak-break sketch: Fixture: diffFeed(prevOpenKeys=['we#5@abc:at-round-limit'], items=[{repo:'we',pr:5,head:'abc',kind:'at-round-limit',reason:'ci-heal exhausted 3/3'}], now) after a first alert 'round cap 4/4'. Assert a NEEDS-YOU line is produced for the new reason; fails today…

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
