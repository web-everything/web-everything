---
bornAs: xr8jq55
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/main-ci-red-io.mjs", "we:scripts/conveyor/main-ci-red-core.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5271 (head 199effc60)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5271 (reviewed head `199effc60c79b534fde68ea367068f3d1c87f26e`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/main-ci-red-io.mjs:306` — (edge-case, degraded) A cancelled tip is never rerun when the preceding completed run was green.
   - Scenario: Use runs [successful A, newer cancelled B], both completed and attempt 1, with B as the actual main tip and B's required check cancelled. With default settings and an empty rerun ledger, planMainCiRerun returns a cancelled-tip plan for B. However, probeAndOwnMainCi returns rerun=null and decision.reason=main-green because mainRedState falls back to A and the new guard skips planning. The advertised cancelled-tip recovery should run once even when the older completed result was successful.
   - Claude's re-check: Rerun planning is wrapped in 'if (state.status !== 'green')'. With [green A, cancelled B], the cancelled tip is ignored and state is green, so planMainCiRerun is never called. The cancelled-tip plan only fires when an earlier red exists, as in the test.
2. `we:scripts/conveyor/main-ci-red-core.mjs:166` — (failing-input, degraded) Deduplicating failures by file and title hides distinct non-flaky failures.
   - Scenario: Supply one job log containing 'FAIL we:a.test.mjs &gt; case\nError: Test timed out in 1000ms.\nFAIL we:a.test.mjs &gt; case\nAssertionError: expected 1 to be 2'. Duplicate titles are possible for parameterized or separately declared tests. parseVitestFailures retains only the timeout, and classifyFlakeRun returns eligible=true, reason=flaky-signature. This requests a rerun and postpones repair despite a distinct assertion failure. Preserve failures with different errors, or conservatively veto conflicting duplicate evidence.
   - Claude's re-check: parseVitestFailures keeps only the first (file,title) key and skips later FAIL blocks with the same key. The assertion failure is dropped, only the timeout remains, and classifyFlakeRun returns flaky-signature.
3. `we:scripts/conveyor/main-ci-red-io.mjs:62` — (failing-input, degraded) A source-file rename into a prose path is classified as an unrelated prose-only change.
   - Scenario: After a green run, rename we:scripts/lib/critical-module.mjs to we:docs/critical-module.md without changing its contents. The compare entry has status=renamed, filename=we:docs/critical-module.md, and previous_filename=we:scripts/lib/critical-module.mjs. The query discards previous_filename, returning only the prose destination. Even with a deterministic missing-module failure, classifyFlakeRun returns eligible=true, reason=unrelated-change, delaying repair for a code removal. Include both sides of renames when deciding whether any executable source changed.
   - Claude's re-check: readChangedFiles uses '--jq '[.files[].filename]'', which drops previous_filename. A rename from a .mjs source into docs/*.md yields only the prose path, so with no signature match the unrelated-change rule makes the run eligible.

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
