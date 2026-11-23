---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/fix-slot-borrow.mjs", "we:scripts/lib/__tests__/fix-executor-chain.test.mjs", "we:scripts/lib/fix-executor-chain.mjs", "we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/lib/__tests__/fix-slot-borrow.test.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Add a table-driven routing test over both repair roles (fix and ci-heal) and both modes that asse… (from web-everything/web-everything#7379 review)

Filed mechanically by the unattended review loop (#2749) — every finding below reduced web-everything/web-everything#7379's review (reviewed head `777c6a77ad33f577cfa0ac27b48e130fc866eb3f`) to prevention-outstanding by naming a guard neither captured nor filed:

1. `we:scripts/lib/fix-slot-borrow.mjs:123` — Add a table-driven routing test over both repair roles (fix and ci-heal) and both modes that asserts the launched prompt and the stamped provider for each cell.
2. `we:scripts/lib/__tests__/fix-executor-chain.test.mjs:40` — When a diff deletes a test, require the author to list the guarantees it covered and either re-home or explicitly retire each one. A review lens is the practical form of this.
3. `we:scripts/lib/fix-executor-chain.mjs:39` — Add a cascade-precedence table test that crosses every layer (platform, repo, role, env) for the mode setting.
4. `we:scripts/lib/fix-executor-chain.mjs:130` — A cross-module contract test that fails when a decision field named requiresReview has no reader in the review-dispatch path. Land the consumer in the same change, or gate the flag on a `check:standards` rule for write-only decision fields.
5. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1621` — Make the routing test matrix cross critical x mode x executor. Or have routeFixExecutor force mode=direct whenever critical or executor is antigravity, with a test pinning it.
6. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1314` — A conformance test asserting every CRITICAL_PATH_PREFIXES entry and POLICY_TIER_HOMES member matches `criticalGlobs`. Better, generate the globs from we:critical-work.mjs.
7. `(no file cited)` — Add a deterministic acceptance-evidence check requiring each acceptance criterion to reference a named test or live probe and its result artifact.
8. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1580` — Extend the parameterized mechanical-dispatch test to assert persisted requiresReview for both ordinary and critical scopes.
9. `(no file cited)` — Add a named deployment smoke check that captures daemon dispatch metadata and actual launcher/session evidence for critical and escalated repairs.

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
