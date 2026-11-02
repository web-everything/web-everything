---
kind: story
size: 2
status: open
scope: ["we:daemon-overlays.mjs", "we:prepare.mjs", "we:edge-fetch.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# Rulings do not carry forward, and the review ledger push races

HIGH priority hint. ## (held 2026-10-27 21:36 ET, HIGH) Rulings do not carry forward, and the review ledger push races #5964: the same findings (we:daemon-overlays.mjs:422/:395, we:prepare.mjs:282) were re-raised about 15 times after being fixed or ruled. The gate prints "carried … ruled not-real" but still shows Rulings:[] and Attempt recorded:false. A ledger-write-miss (git push origin HEAD:refs/heads/ops/review-requests rejected) hit at 13:15/14:35/17:56/20:29/22:27Z, held referrals and reopened disputes. Fix: (1) a carried not-real or fixed ruling counts as recorded; (2) the ledger write does fetch, rebase, retry (or a CAS ref update) instead of a bare push; (3) review re-judges against the head sha. Merges with the 12:56 ledger card. #5964 non-convergence result: clear it through the human ceremony with cards: we:edge-fetch.mjs:29 mainOnly malformed entry; we:prepare.mjs:293 ref-gone squash; we:daemon-overlays.mjs:284 stale sha on re-register; :399 force-push container / we:prepare.mjs:447 restored-source plan (if real).

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
