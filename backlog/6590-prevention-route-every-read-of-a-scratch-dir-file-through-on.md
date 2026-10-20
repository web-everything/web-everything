---
bornAs: xib9amu
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-load-overlay.mjs", "we:scripts/lib/__tests__/daemon-boot-smoke.test.mjs", "we:scripts/lib/__tests__/daemon-load-overlay.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — Route every read of a scratch-dir file through one hardened reader (O_NOFOLLOW, O_NONBLOCK, isFil… (from web-everything/web-everything#5460 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-load-overlay.mjs:477` — Route every read of a scratch-dir file through one hardened reader (O_NOFOLLOW, O_NONBLOCK, isFile, size cap). Coerce `ms` with `Number.isFinite`. Add a `check:standards` lint that forbids raw `readFileSync` on paths under the dispatch-smoke scratch dir.
2. `we:scripts/lib/__tests__/daemon-boot-smoke.test.mjs` — Add a deterministic test named 'honors bootConcurrency=1 with multiple pending entries' in we:scripts/lib/__tests__/daemon-boot-smoke.test.mjs: supply several entries, hold the first child pending, assert exactly one spawn, then resolve children and assert peak concurrency remains one. This test should redden if the scheduler uses a literal three instead of settings.bootConcurrency.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5460@2640c4d42f8c75b5b7ab524208f8005612f1d09a

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
