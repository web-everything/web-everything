---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/fix-claim-store.mjs", "we:scripts/conveyor/soak/breaks/push-gate-hold-refusal.mjs", "we:scripts/lib/__tests__/helpers/authorized-push-factory.mjs", "we:scripts/lib/__tests__/authorized-push.test.mjs", "we:scripts/lib/__tests__/authorized-push-s1c.test.mjs", "we:scripts/conveyor/__tests__/fix-claim-store.test.mjs", "we:scripts/conveyor/soak/breaks/__tests__/push-gate-hold-refusal.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Add a contract test that feeds each claim writer's output (acquireFixClaim, the dispatcher's acqu… (from web-everything/web-everything#7442 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/fix-claim-store.mjs:119` — Add a contract test that feeds each claim writer's output (acquireFixClaim, the dispatcher's acquire, fixBegin with non-lane and lane heads) through validateFixClaimMeta and the strict scan. Also make the strict scan ignore, or separately classify, expired entries and non-claim names so one bad entry cannot poison every push.
2. `we:scripts/conveyor/soak/breaks/push-gate-hold-refusal.mjs:27` — Either allowlist the soak break explicitly in `nonTestFactoryImports` and assert the allowlist is exactly that one file, or extend the regex to match the literal factory filename anywhere in a non-test file. Put the check in check:standards rather than only in a vitest test.
3. `we:scripts/conveyor/fix-claim-store.mjs:143` — Add a test that spies on `readdirSync` or removes the directory on the first read, and asserts `{entries: [], unreadable: false}`. File it as a backlog item.
4. `we:scripts/conveyor/soak/breaks/push-gate-hold-refusal.mjs:1` — Record the live-probe transcript on the PR as the evidence artifact, and keep the hermetic tests as the standing guard.
5. `we:scripts/lib/__tests__/helpers/authorized-push-factory.mjs:21` — Share the implementation through an internal module and add a static gate rejecting source-recompilation test harnesses.
6. `we:scripts/lib/__tests__/authorized-push.test.mjs` — Require a machine-checkable acceptance-to-test manifest that includes integration probes and validates referenced test names.
7. `we:scripts/conveyor/fix-claim-store.mjs` — Add deterministic filesystem fault injection covering both outcomes of the ENOENT recheck, and include that branch in mutation testing.
8. `we:scripts/lib/__tests__/authorized-push-s1c.test.mjs` — Add an acceptance-to-test manifest checked by a deterministic gate, requiring each guarantee to identify a named test and its observable assertion.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7442@725ab0331c5fdf71a68a9c720c2e854239a054df

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
