---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-rebuild/state.mjs", "we:scripts/lib/daemon-rebuild/prepare.mjs", "we:scripts/lib/daemon-rebuild/orchestrator-ask.mjs", "we:scripts/lib/daemon-rebuild/__tests__/state.test.mjs", "we:scripts/lib/daemon-rebuild/__tests__/prepare.test.mjs", "we:scripts/lib/daemon-rebuild/__tests__/orchestrator-ask.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Add two negative cases to we:daemon-rebuild-ready.test.mjs: a tip descending from pin.sha but not… (from web-everything/web-everything#7487 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-rebuild/state.mjs:272` — Add two negative cases to we:daemon-rebuild-ready.test.mjs: a tip descending from pin.sha but not pinnedFrom, and one descending from pinnedFrom but not pin.sha. A mutation check on guard conjunctions would catch the class.
2. `we:scripts/lib/daemon-rebuild/state.mjs:268` — Add a test with an injected `run` returning status 128 (and one throwing) for merge-base, expecting StaleReadyPinError, plus a graft-file fake-ancestry test beside the replace-ref one.
3. `we:scripts/lib/daemon-rebuild/prepare.mjs:448` — Add a rebuild test that sets WE_ORCHESTRATOR_ASKS_PATH, produces an overlay-unaudited-tip hold and asserts one line with key pin-moved:<ref>@<adopted>. This could ride on ORCH-ASK-DEDUPE-HARDEN if that card names it.
4. `we:scripts/lib/daemon-rebuild/prepare.mjs:449` — Persist the unwritable notice in the same state record as pinnedNotified, with a two-tick test asserting one alert; file it with ORCH-ASK-DEDUPE-HARDEN.
5. `we:scripts/lib/daemon-rebuild/state.mjs:272` — File a card for two negative tests in we:daemon-rebuild-ready.test.mjs: (1) the held tip is rewritten but still descends from pin.sha; (2) the tip descends from pinnedFrom but not from pin.sha. Longer term, a mutation check on changed guard conditions.
6. `we:scripts/lib/daemon-rebuild/state.mjs:269` — File a card for a table test in we:pin-provenance.test.mjs where the injected `run` makes merge-base throw, return status 128 and return status null, each expecting StaleReadyPinError.
7. `we:scripts/lib/daemon-rebuild/state.mjs:238` — Add a graft-file negative case beside the replace-ref test in we:daemon-rebuild-ready.test.mjs.
8. `we:scripts/lib/daemon-rebuild/prepare.mjs:446` — Add to the queued ORCH-ASK-DEDUPE-HARDEN card: a rebuild-level test with WE_ORCHESTRATOR_ASKS_PATH set that asserts one ask for an unaudited tip and none under strictState, plus a test for the VITEST skip.
9. `we:scripts/lib/daemon-rebuild/state.mjs:269` — Add a deterministic parameterized test for thrown and nonzero operational merge-base failures.
10. `we:scripts/lib/daemon-rebuild/orchestrator-ask.mjs:4` — Gate changes with injected read-failure tests and a rebuild integration test asserting successful adoption despite ask I/O failures.
11. `we:scripts/lib/daemon-rebuild/orchestrator-ask.mjs:31` — Add a deterministic test matrix covering absent and explicit path overrides with process-level and supplied-environment VITEST flags.
12. `we:scripts/lib/daemon-rebuild/orchestrator-ask.mjs:20` — Add a deterministic regression test with the matching key before the final 4 MiB, and persist deduplication independently of the bounded journal read.
13. `we:scripts/lib/daemon-rebuild/state.mjs:270` — Gate this code with a parameterized test covering thrown errors and nonzero operational statuses from each ancestry check.
14. `we:scripts/lib/daemon-rebuild/orchestrator-ask.mjs:4` — Add deterministic read-error injection and an adoption integration test asserting successful adoption and exactly one orchestrator-ask-unwritable alert.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7487@b233ae179da2d2aad4914c41dd21dba189969a45

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
