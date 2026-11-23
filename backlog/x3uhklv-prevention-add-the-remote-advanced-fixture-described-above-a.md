---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/__tests__/daemon-overlay-audit-check.test.mjs", "we:scripts/daemon-overlay.mjs", "we:scripts/lib/daemon-load-overlay.mjs", "we:scripts/__tests__/daemon-overlay.test.mjs", "we:scripts/lib/__tests__/daemon-load-overlay.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Add the remote-advanced fixture described above as a named test. Optionally add a lint that bans… (from web-everything/web-everything#7369 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/__tests__/daemon-overlay-audit-check.test.mjs:60` — Add the remote-advanced fixture described above as a named test. Optionally add a lint that bans `fetch`/`ls-remote` in read-only inventory scripts.
2. `we:scripts/daemon-overlay.mjs:1077` — Add a lock-ordering test that stubs `withAddGuardLock` or holds the lock file and checks the gate's timing. Alternatively, structure the code so the gate is a parameter of the guard callback and cannot be called outside it.
3. `we:scripts/daemon-overlay.mjs:646` — Add a lock-held test: take the add-guard lock in `lockFixture`, start `add` or `replace`, and assert no evidence read and no registration write occurs until the lock is released. Preferred form is a deterministic test, not a doc note.
4. `we:scripts/lib/daemon-load-overlay.mjs:245` — Log a distinct warning or event whenever the effective mode was loosened through `WE_PLATFORM_PREFERENCES_FILE`, or add a standards check that production code paths do not honour that seam. File as a backlog item.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7369@a337fcbf4c56fd507b80c455d755831b9639dcdb

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
