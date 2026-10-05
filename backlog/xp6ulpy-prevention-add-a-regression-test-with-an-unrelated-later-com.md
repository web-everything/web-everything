---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/conveyor/tick-core.mjs", "we:scripts/conveyor/main-red-recovery.mjs", "we:scripts/conveyor/ci-heal-mark.mjs", "we:scripts/operations/land-advance-repair.mjs", "we:scripts/conveyor/__tests__/reconcile-pass.test.mjs", "we:scripts/conveyor/__tests__/tick-core.test.mjs", "we:scripts/conveyor/__tests__/main-red-recovery.test.mjs", "we:scripts/conveyor/__tests__/ci-heal-mark.test.mjs", "we:scripts/operations/__tests__/land-advance-repair.test.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Prevention — Add a regression test with an unrelated later commit on the emitter, and cap or sanity-check the… (from web-everything/web-everything#3970 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-pass.mjs:540` — Add a regression test with an unrelated later commit on the emitter, and cap or sanity-check the attributed window width. Optionally require that the fragment text differs between failure time and the main tip (git grep at the failure-time sha vs origin/main) before treating it as fixed.
2. `we:scripts/conveyor/tick-core.mjs:891` — Track the refund against the durable floor only (chargeable comment count), leaving the in-session tally untouched, and add a test with in-session attempts and no comments.
3. `we:scripts/conveyor/main-red-recovery.mjs:375` — Add a test that mixes a spoofed `error ` line with an unprefixed FAIL line. Require a failing-step/exit-code corroboration, or only parse errors from the check-standards step. Add a lint rule banning PR-log-derived data from feeding budget or cap decisions without a corroborating main-side fact.
4. `we:scripts/conveyor/ci-heal-mark.mjs:90` — Parse `attributed-window:` only from the fixed header lines, between the marker and the `conveyor rebase-onto-main` line. Collapse newlines in `error` inside buildRebaseOntoMainComment. Add a round-trip test with an injected newline.
5. `we:scripts/conveyor/reconcile-pass.mjs:539` — Add a deterministic attribution regression test where an unrelated emitter-file edit follows the failure and must not grant attribution or refunds; require evidence connecting the changed behavior to the signature before granting them.
6. `we:scripts/operations/land-advance-repair.mjs:39` — Add a deterministic regression with historical refunded comments absent from the ledger and new ledger-only attempts; refund only ledger entries correlated with eligible attempts.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3970@a2d6a71d2e7ede82b56750bbea1b8a870af13ce1

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
