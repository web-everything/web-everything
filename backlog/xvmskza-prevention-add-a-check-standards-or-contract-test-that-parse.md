---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/hotpatch-readers.mjs", "we:scripts/lib/daemon-rebuild/audited-tip.mjs", "we:scripts/operations/__tests__/prototype-load.test.mjs", "we:scripts/lib/__tests__/hotpatch-guards.test.mjs", "we:scripts/lib/daemon-load-overlay.mjs", "we:scripts/lib/__tests__/hotpatch-readers.test.mjs", "we:scripts/lib/daemon-rebuild/__tests__/audited-tip.test.mjs", "we:scripts/lib/__tests__/daemon-load-overlay.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Add a check:standards or contract test that parses we:ci.yml on main and asserts every job in the… (from web-everything/web-everything#7361 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/hotpatch-readers.mjs:62` — Add a check:standards or contract test that parses we:ci.yml on main and asserts every job in the receipt groups can reach success on a pull_request event. Allowlist expected skips explicitly.
2. `we:scripts/lib/daemon-rebuild/audited-tip.mjs:98` — Reset the call counter per admitHotpatch call, or create a reader per ref. Add a test with several applied hotpatch refs.
3. `we:scripts/operations/__tests__/prototype-load.test.mjs:348` — Test-authoring rule: one guard per scenario, with every other precondition green. Give the urgent refusal a distinct detail string.
4. `we:scripts/lib/__tests__/hotpatch-guards.test.mjs:196` — Extend the grep test to we:scripts/lib/hotpatch-readers.mjs. Better, add a behavioural test that spies on plan, adopt and rebuild during a full add.
5. `we:scripts/lib/daemon-load-overlay.mjs:81` — Put the hotpatch admission inside the shared add guard. `stackAwareOverlayCheck` and `guardedRegister` should require `admitHotpatch` for any `hotpatch/` ref, or a `check:standards` rule should fail when a non-test file calls `addOverlay` outside the guarded wrappers. Add a test that registers a hotpatch ref through each registration entry point and expects a refusal.
6. `we:scripts/lib/__tests__/hotpatch-guards.test.mjs:225` — Extend the source assertion to `we:scripts/lib/hotpatch-readers.mjs`. Add a behavioural test that runs the add path with spies on `rebuildClone`, `planRebuild` and `finalizeRebuild` and expects zero calls. A lint rule banning rebuild imports in `hotpatch-*.mjs` would also work.
7. `we:scripts/lib/__tests__/hotpatch-guards.test.mjs:178` — Add a named test 'hotpatch apply never invokes lifecycle entry points' in we:scripts/__tests__/daemon-overlay.test.mjs that exercises admission and add with lifecycle entry points instrumented to fail on invocation.
8. `we:scripts/lib/__tests__/hotpatch-guards.test.mjs:172` — Add 'audit ledger reads at most the limit plus one byte' in we:scripts/lib/__tests__/hotpatch-guards.test.mjs, asserting the requested read range or total bytes read through an instrumented filesystem.
9. `(no file cited)` — Require acceptance entries to reference a repository-qualified test file and exact test name, with a deterministic check that the referenced test exists.
10. `we:scripts/lib/hotpatch-readers.mjs:95` — Use a bounded read and add a named regression test asserting that an oversized ledger consumes at most the configured limit plus one byte.
11. `we:scripts/lib/__tests__/hotpatch-guards.test.mjs:175` — Require an Acceptance-to-named-test mapping and add an apply-path regression test that fails if plan, adopt, or rebuild is invoked.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7361@20f0d672b6011c1e0f4fbce5ed1ba7ff7dba04ca

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
