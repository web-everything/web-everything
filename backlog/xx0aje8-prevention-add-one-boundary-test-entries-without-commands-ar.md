---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/push-gate-lint.mjs", "we:scripts/lib/__tests__/push-gate-lint.test.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Prevention — Add one boundary test, 'entries without commands are unaffected by option shape', asserting that… (from web-everything/web-everything#7613 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/push-gate-lint.mjs:154` — Add one boundary test, 'entries without commands are unaffected by option shape', asserting that `findRawPushes` with `commands` undefined returns the same sites for `{shell:true}` options as for no options. A mutation run on `commands !== undefined` would then be a deterministic check.
2. `we:scripts/lib/push-gate-lint.mjs:140` — Add a branch-coverage threshold for `we:scripts/lib/push-gate-lint.mjs`, or table-drive the option-shape tests from the predicate's own clauses.
3. `we:scripts/lib/push-gate-lint.mjs:139` — When a pin is added, require the allowlist `reason` to state that operands are not pinned. Alternatively add a denylist of operand-executing subcommands (`submodule foreach`, `bisect run`) that the lint refuses to pin.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7613@2b0d056c4ee5d0bb45b5a10a71dc57fab73b9a2b

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
