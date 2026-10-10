---
bornAs: xo567xi
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-rebuild/rebuild.mjs", "we:scripts/lib/daemon-rebuild/smoke.mjs", "we:scripts/lib/daemon-rebuild/__tests__/rebuild.test.mjs", "we:scripts/lib/daemon-rebuild/__tests__/smoke.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Add a test in we:daemon-rebuild-job.test.mjs that pre-records a ready candidate and then runs the… (from web-everything/web-everything#4731 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-rebuild/rebuild.mjs:63` — Add a test in we:daemon-rebuild-job.test.mjs that pre-records a ready candidate and then runs the readyOnly path, asserting reason ready-pending, an unchanged head and no smoke call. More generally, add a lint/standards rule that every early-return branch added next to a prose invariant ('never moves the clone') has a named test.
2. `we:scripts/lib/daemon-rebuild/smoke.mjs:381` — Parameterise the existing daemon-rebuild-fallback and load-confirm test matrices over `readyOnly` (record, then adoptOnly adopt) so every `finalize` caller is exercised in job mode.
3. `we:scripts/lib/daemon-rebuild/rebuild.mjs:59` — Add a deterministic test matrix for legacy and versioned backends that checks adoptOnly performs no build or smoke and readyOnly never changes the active version.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4731@3d8df67c238b2446d0b3cff3aeb24eb73967cd46

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
