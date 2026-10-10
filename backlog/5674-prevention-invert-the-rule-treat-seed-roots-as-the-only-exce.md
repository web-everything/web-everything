---
bornAs: x00pirw
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-clone-registry.mjs", "we:scripts/lib/__tests__/daemon-clone-registry.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Invert the rule: treat seed roots as the only exceptions and refuse everything else under .lanes/… (from web-everything/web-everything#4719 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-clone-registry.mjs:93` — Invert the rule: treat seed roots as the only exceptions and refuse everything else under `.lanes/`. That would make the fix just the new seed entry and drop the shape predicate. Alternatively, add a test that enumerates the real `.lanes/` layout (including `<repo>/frontierui` siblings) and asserts each is classified as intended.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4719@9783c0f659f2c8bcc004b6b5bc392bb65b4c8a4d

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
