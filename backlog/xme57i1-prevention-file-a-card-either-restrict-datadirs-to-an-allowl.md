---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/pr-size-settings.mjs", "we:scripts/lib/__tests__/pr-size-admission.test.mjs", "we:scripts/lib/__tests__/pr-size-settings.test.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Prevention — File a card: either restrict dataDirs to an allowlist or document that it is operator-trusted, th… (from web-everything/web-everything#7549 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/pr-size-settings.mjs:13` — File a card: either restrict `dataDirs` to an allowlist or document that it is operator-trusted, then add a test that fails if a new exemption route is added without the ruled-glob check. A `check:standards` rule that every settings field feeding `isDataPath` goes through ruled validation would catch the whole class.
2. `we:scripts/lib/pr-size-settings.mjs:9` — Add the deterministic test `accepts explicit data paths outside ruled wildcard families in every settings layer` to web-everything/web-everything:we:scripts/lib/__tests__/pr-size-admission.test.mjs, asserting that an explicit override such as we:exports/catalog.json survives platform, tool, and environment resolution. That named test should fail if explicit paths are restricted to the wildcard families.
3. `we:scripts/lib/__tests__/pr-size-admission.test.mjs:32` — Add a table-driven resolver test covering all four authorized families and representative narrower patterns across platform, tool, and environment layers, and run it in CI.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7549@c5982d50ba975341a46b0b75fca19d929d533be4

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
