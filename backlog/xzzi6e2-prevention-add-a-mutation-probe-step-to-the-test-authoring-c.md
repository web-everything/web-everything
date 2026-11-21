---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/backlog-move/cli.mjs", "we:scripts/backlog-move/__tests__/reconcile.test.mjs", "we:scripts/backlog-move/reconcile.mjs", "we:scripts/backlog-move/__tests__/cli.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a mutation-probe step to the test-authoring checklist: weaken each bound once and confirm a n… (from web-everything/web-everything#7312 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/backlog-move/cli.mjs:108` — Add a mutation-probe step to the test-authoring checklist: weaken each bound once and confirm a named test reddens. Keep oversize fixtures well-formed so only the bound can reject them.
2. `we:scripts/backlog-move/cli.mjs:1` — Add a harness-level allowlist (git subcommands and gh verbs) that fails the test on any other call. Add a check:standards rule that flags new `throw ... bound` guards in scripts/ with no matching test name.
3. `we:scripts/backlog-move/cli.mjs:4` — When a requirement is deferred between slices, grep the changed files for its keyword in the same commit. A doc note is enough.
4. `we:scripts/backlog-move/__tests__/reconcile.test.mjs:96` — Add one test that records every `run` call and asserts `bin`/subcommand membership in a fixed read-only allowlist, with the harness throwing outside any try/catch. Longer term, a check:standards rule forbidding writeFileSync/fetch/push in scripts/backlog-move until slice 3.
5. `we:scripts/backlog-move/cli.mjs:5` — Doc note: reword the header to 'ambient gh identity, GETs only; App token enforced in slice 3 via assertWriterToken'.
6. `we:scripts/backlog-move/cli.mjs:4` — Add boundary fixtures for each limit and a deterministic mutation gate requiring the corresponding named test to fail when its guard is removed.
7. `we:scripts/backlog-move/cli.mjs:94` — Add a deterministic regression test distinguishing inaccessible contents from independently verified absence.
8. `we:scripts/backlog-move/cli.mjs:128` — Add a table-driven collision test covering mismatched filenames and declared IDs.
9. `we:scripts/backlog-move/cli.mjs:141` — Parameterize the coexistence regression over matching and conflicting lineage, requiring quarantine for both.
10. `we:scripts/backlog-move/cli.mjs:78` — Add fixture-based tests with distinct snapshot/main trees and supported structured reference forms.
11. `we:scripts/backlog-move/reconcile.mjs:15` — Represent link-reconciliation evidence explicitly and add a crash-recovery test for interruption after stub creation.
12. `we:scripts/backlog-move/__tests__/reconcile.test.mjs:84` — Make the injected command runner reject every command outside an explicit read-only allowlist and exercise both plan and status.
13. `we:scripts/backlog-move/cli.mjs:4` — Add deterministic boundary tests named 'rejects oversized manifest', 'rejects oversized source tree', 'stops at inbound scan budget', and 'stops at GitHub call budget', including assertions on subsequent reads or calls.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7312@0ffddadbcfebba5deed89f65feee20dfdb4a04fd

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
