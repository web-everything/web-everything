---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/lib/fix-slot-borrow.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7384 (head a8d905e7c)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7384 (reviewed head `a8d905e7ce1cd8b6878a24f2fe6636d4c9e99f44`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1324` — (failing-input, degraded) The live daemon bypasses the configured critical globs
   - Scenario: Dispatch a repair scoped to we:scripts/lib/dispatch-supervisor-contract.mjs. The shipped criticalGlobs includes scripts/lib/dispatch-**, so requiresReview should be true. However, we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs supplies criticalFor using criticalWorkVerdict, bypassing this new default predicate. That predicate returns false for this existing file, and the resulting Codex decision records requiresReview=false. Custom criticalGlobs overrides are likewise ignored by the live daemon.
   - Class: correctness-in-normal-use (basis: The production caller explicitly overrides criticalFor. Native Node probes confirmed that the shipped glob covers this path, while the daemon's predicate and resulting executor decision return false for criticality and requiresReview.)
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/fix-slot-borrow.mjs:123` — (failing-input, degraded) Wrapped CI-heal discards the selected executor and supervision instruction
   - Scenario: Set fixExecutor.executionModeByRole.ci-heal to wrapped and dispatch a stronger-model CI-heal that selects codex-alt with gpt-6-astra/high. This condition sends it through the unchanged default sinks without forwarding the selected policyRoute or adding a Codex supervision instruction. Because strongerModel remains true, dispatchCiHeal selects its Claude route and Claude performs the repair itself. The claim nevertheless records Codex/codex-alt/wrapped. The wrapper should supervise the selected Codex model and preserve accurate dispatch metadata.
   - Class: correctness-in-normal-use (basis: A native probe of createRoutedCiHealDispatch with inert sinks confirmed that a wrapped codex-alt decision supplies no provider override and forwards an unchanged prompt without the selected policyRoute. The downstream strongerModel branch explicitly selects Claude.)
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
