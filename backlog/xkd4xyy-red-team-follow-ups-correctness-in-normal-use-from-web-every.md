---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/lib/fix-slot-borrow.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7384 (head d8995cf0f)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7384 (reviewed head `d8995cf0ff26422b53fb0259a3fb3a44de0abed9`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1324` — (failing-input, degraded) The daemon bypasses the configured criticalGlobs predicate
   - Scenario: Set fixExecutor.criticalGlobs to ["blocks/**"] and dispatch a fix scoped to "we:blocks/selection/example.ts". The daemon explicitly supplies criticalFor using criticalWorkVerdict, overriding this new default predicate. Its verdict is false, so requiresReview is false despite the configured match. The daemon should apply the configured critical globs.
   - Class: correctness-in-normal-use (basis: The resolver probe retained ["blocks/**"], while the exact predicate supplied by the daemon returned critical:false. The production override is at we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs:1316.)
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/fix-slot-borrow.mjs:123` — (failing-input, degraded) Wrapped CI-heal discards the selected repair executor
   - Scenario: Configure executionModeByRole.ci-heal="wrapped" and select codex-alt for a strongerModel CI-heal. This condition leaves the original sinks and routing intact without forwarding the selected model or adding supervision instructions. dispatchCiHeal then selects its existing Claude stronger-model route, which repairs directly instead of supervising Codex. Executor metadata nevertheless records Codex. Wrapped CI-heal should preserve the selected executor and model.
   - Class: correctness-in-normal-use (basis: A probe of createRoutedCiHealDispatch confirmed no provider override and an unchanged repair prompt, despite stamping codex-alt. The existing dispatchCiHeal strongerModel branch explicitly supplies a Claude policyRoute.)
   - Claude's re-check: demonstrated break

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
