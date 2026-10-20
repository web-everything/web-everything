---
bornAs: xqhc3pp
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/accept-carry-forward.mjs", "we:scripts/lib/__tests__/accept-carry-forward.replay.test.mjs", "we:scripts/lib/__tests__/accept-carry-forward.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — Build the notice text from a single exported builder in we:approval-prevention-notice.mjs and hav… (from web-everything/web-everything#5506 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/accept-carry-forward.mjs:148` — Build the notice text from a single exported builder in we:approval-prevention-notice.mjs and have both the filer and the recogniser use it. Add a round-trip test that generates each filer outcome (numeric id, hash id, '?', pid handle, untracked job) and asserts isKnownMachineBody is true.
2. `we:scripts/lib/accept-carry-forward.mjs:148` — Derive the positive test cases from the filer's own builder, so every notice shape it can emit is asserted tolerable by round-trip. Capture this as a shared test helper in we:approval-prevention-notice.mjs.
3. `we:scripts/lib/accept-carry-forward.mjs:137` — Add a characterization test that a notice from an untrusted author is tolerated on the body-only paths. Or thread author metadata through those consumers in a follow-up card.
4. `we:scripts/lib/__tests__/accept-carry-forward.replay.test.mjs:1168` — Add a table-driven contract test to the existing test gate covering every supported filer outcome, asserting recognition of each complete body and rejection after appended prose.
5. `we:scripts/lib/accept-carry-forward.mjs:143` — Add a deterministic table-driven contract test covering each filer output variant, including backlog-card notices and the untracked-job fallback, and asserting each generated notice is recognized.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5506@ba61f750d646af8cdb5b625de5228f6cf6a7e76c

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
