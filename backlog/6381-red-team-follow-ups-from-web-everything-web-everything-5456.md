---
bornAs: xde5lng
kind: story
size: 2
status: open
scope: ["we:scripts/lib/daemon-rebuild/smoke.mjs"]
dateOpened: "2026-10-16"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5456 (head d288aaec8)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5456 (reviewed head `d288aaec8ac285d0d1cd6f23ecbcae1a37b8ec1c`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/daemon-rebuild/smoke.mjs:861` — (edge-case, degraded) Cached last-good controls block recovery despite reproducing every candidate failure.
   - Scenario: Give last-good C a fresh passing proof, then rebuild an uncached candidate A. Both smokes fail only daemon-entries-boot with the same harness error; C actually reruns that env check. The new !c.reused guard nevertheless prevents the default adopt-as-no-worse recovery. A read-only VM probe returned smoke-harness-broken with reuse enabled, versus harness-broken-adopted-not-worse with reuse disabled. This can hold a candidate containing the harness fix until C's proof expires, normally up to 12 hours. Preserve recovery when every candidate failure was freshly reproduced by C, or rerun C without r
   - Claude's re-check: Line 861 '!c.reused &&' always skips adopt-as-no-worse when last-good C reused a proof. C then only runs env rows and skips code rows. If A failed only an env row that C reproduced, harnessBroken is true but adoption is withheld and the path goes to smoke-harness-broken, a hold with backoff. The guard does not distinguish this case.

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
