---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/readiness/heavy-admission.mjs", "we:docs/agent/testing/remote-targets.md", "we:scripts/readiness/remote-exec.mjs", "we:scripts/readiness/__tests__/remote-target.test.mjs", "we:scripts/readiness/remote-target.mjs", "we:scripts/readiness/__tests__/heavy-admission.test.mjs", "we:scripts/readiness/__tests__/remote-exec.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Add a test asserting that no probe runs when decideRemote already returns local. Review lens: any… (from web-everything/web-everything#7427 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/readiness/heavy-admission.mjs:1322` — Add a test asserting that no probe runs when `decideRemote` already returns local. Review lens: any new pre-decision I/O must be gated on the decision outcome.
2. `we:scripts/readiness/heavy-admission.mjs:424` — Add a multi-layer precedence test for `remote.hosts` in the policy cascade tests.
3. `we:docs/agent/testing/remote-targets.md:3` — Add a table-driven test over every `ADMISSION_VALID` leaf that asserts the tool and env layers are ignored in a shared pool unless the leaf is in `PER_CALLER_LEAVES`. A new leaf then gets the check without its author writing one.
4. `we:scripts/readiness/remote-exec.mjs:1310` — Add a shared entry-point test matrix that runs the same invalid host and root set through `runRemote`, `presync` and `spawnPresync`.
5. `we:scripts/readiness/__tests__/remote-target.test.mjs:65` — Add deterministic tests in we:scripts/readiness/__tests__/remote-target.test.mjs named 'dry discovery loads configured hosts when omitted' (assert configured SSH aliases and order), 'shared pools ignore tool remote.hosts overrides' (assert platform hosts remain selected), and 'discovery reprobes hosts on every call' (change mocked health between calls and assert renewed SSH calls and selection).
6. `we:scripts/readiness/remote-target.mjs:17` — Add a deterministic integration test that supplies a distinctive normal connection option and asserts that discovery's spawned SSH arguments retain it alongside the discovery deadlines.
7. `we:docs/agent/testing/remote-targets.md:4` — Add a table-driven policy test gate covering platform/tool precedence and shared/private pool behavior for each newly introduced host-wide setting.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7427@3b588a10e64e041566598d4bd6d70050ee914ee3

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
