---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/fix-slot-borrow.mjs", "we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/conveyor/__tests__/fix-executor-routing.test.mjs", "we:scripts/settings/fix-executor.json", "we:scripts/lib/__tests__/fix-slot-borrow.test.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Add a parity test that runs every dispatch entry point (fix and ci-heal) under each execution mod… (from web-everything/web-everything#7384 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/fix-slot-borrow.mjs:143` — Add a parity test that runs every dispatch entry point (fix and ci-heal) under each execution mode and asserts the launched prompt or launcher.
2. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1583` — Add a dispatchFix test with a borrowed decision under WE_FIX_EXECUTOR_EXECUTION_MODE=wrapped, or pin borrowed decisions to direct.
3. `we:scripts/lib/fix-slot-borrow.mjs:92` — Default modeSource to 'unknown' in the formatter, and make the log-format test assert there is no 'undefined' in the output.
4. `we:scripts/conveyor/__tests__/fix-executor-routing.test.mjs:805` — Parameterise the critical-path dispatch test over `mode` (direct and wrapped), or state in the Acceptance that the guarantee is for default mode only.
5. `we:scripts/settings/fix-executor.json:4` — Add a standards or test rule that the file defining criticalGlobs, and the settings reader it flows through, match its own criticalGlobs.
6. `(no file cited)` — Require each Acceptance entry to reference a named test or explicit operational verification artifact before marking it verified.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7384@a8d905e7ce1cd8b6878a24f2fe6636d4c9e99f44

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
