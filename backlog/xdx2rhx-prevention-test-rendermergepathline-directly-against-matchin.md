---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/__tests__/worker-brief.test.mjs", "we:scripts/lib/brief-header.mjs", "we:scripts/lib/__tests__/brief-header.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Test renderMergePathLine directly against matching and non-matching strings. Export the pattern f… (from web-everything/web-everything#7434 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/__tests__/worker-brief.test.mjs:838` — Test renderMergePathLine directly against matching and non-matching strings. Export the pattern from a shared module the hook also imports, with a parity test. File as a backlog item (dlv:BRIEF-TEMPLATE-HARDEN covers this).
2. `we:scripts/lib/brief-header.mjs:13` — Add a contract test that feeds generated briefs to the hook's decide function, or move the routing and merge-path rules into a shared lib the hook imports. File as a backlog item.
3. `we:scripts/lib/brief-header.mjs:27` — Add a unit test per guard. A lighter option is a standards check that every throw in we:scripts/lib/brief-header.mjs is matched by an expect(...).toThrow in its test file.
4. `we:scripts/lib/brief-header.mjs:23` — Add a table-driven negative test over every value interpolated into the header (step, kind, slot, prepPath). Alternatively, add a lint that flags template interpolation of unvalidated values into the brief header.
5. `we:scripts/lib/brief-header.mjs:7` — Export the pattern from the hook, or from a shared lib, and import it here. Alternatively, add a drift test that runs generated briefs through guard-delivery-mode decide() for each Kind, as the test already does for guard-prep with slots.
6. `we:scripts/lib/brief-header.mjs:22` — Add a deterministic boundary test through renderBriefHeader asserting acceptance at 128 KiB and rejection at 128 KiB plus one byte.
7. `we:scripts/lib/brief-header.mjs:22` — Add a deterministic boundary test in we:scripts/__tests__/worker-brief.test.mjs exercising renderBriefHeader with regular files of exactly 128 KiB and 128 KiB plus one byte, asserting acceptance and rejection respectively.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7434@47c7a2c7e98991f5705d1ace72c0f4c307301704

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
