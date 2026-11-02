---
bornAs: xwiwszx
kind: story
size: 2
status: open
scope: ["we:daemon-rebuild-hold-live-pinned.test.mjs", "we:worker-wrapper.test.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# Flaky on loaded CI runners

MED priority hint. - [MED] Flaky on loaded CI runners: we:daemon-rebuild-hold-live-pinned.test.mjs (2 tests, 5000ms default timeout; ~9s on main) and we:worker-wrapper.test.mjs agy case (expected agy-key-absent, got no-structured-output). Seen on #6023 10-29 23:20 ET. Give explicit timeouts / make the agy case hermetic.

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
