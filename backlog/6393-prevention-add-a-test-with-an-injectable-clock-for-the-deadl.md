---
bornAs: xdgvudr
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/fix-scope-fence-io.mjs", "we:scripts/conveyor/fix-scope-fence.mjs", "we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/conveyor/__tests__/fix-scope-fence-io.test.mjs", "we:scripts/conveyor/__tests__/fix-scope-fence.test.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Prevention — Add a test with an injectable clock for the deadline branch. Longer term, add a check:standards r… (from web-everything/web-everything#5461 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/fix-scope-fence-io.mjs:131` — Add a test with an injectable clock for the deadline branch. Longer term, add a check:standards rule that each numeric limit named in docs/agent/*.md maps to a test referencing it.
2. `we:scripts/conveyor/fix-scope-fence.mjs:139` — Add a we:fix-scope-fence.test.mjs case where standDown throws and expect { ok:false, scopeFence:true, transient:true }. A lint for unguarded I/O sinks in push ports would catch this class.
3. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:944` — Add a table-driven test to the prompt-ownership suite that runs every launch path (fresh, borrowed, round resume, conflict resume) with unreadable history and asserts the incomplete-evidence warning.
4. `we:scripts/conveyor/fix-scope-fence-io.mjs:96` — Inject a clock into `readDiff` and add a test that advances it past the deadline and expects the 'repair history exceeds' stand-down. A review lens for 'every stated bound has a test per bound' would catch this class.
5. `we:scripts/conveyor/fix-scope-fence-io.mjs:173` — Add an adapter-level test with a throwing settings reader in warn mode that expects the push to be called. Wrap policy resolution so that, on failure in warn mode, the push proceeds.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5461@6ab86c90b327f86466ed99b61db141d821890e06

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
