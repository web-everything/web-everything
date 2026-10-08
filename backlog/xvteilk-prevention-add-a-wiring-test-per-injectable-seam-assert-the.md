---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:skills-src/conveyor/review-daemon.mjs", "we:scripts/conveyor/scope-bloat.mjs", "we:skills-src/conveyor/__tests__/review-daemon.test.mjs", "we:scripts/conveyor/__tests__/scope-bloat.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Add a wiring test per injectable seam: assert the default enrichScopeBloat is applied by runRecon… (from web-everything/web-everything#4443 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:skills-src/conveyor/review-daemon.mjs:858` — Add a wiring test per injectable seam: assert the default `enrichScopeBloat` is applied by `runReconcilePass`, and that `buildCliDaemonEffects` passes `refreshScopeBloat` and `postRefreshMarker` to the tick. A broader gate would be a check:standards rule requiring each new `enrich*` or effect default to be exercised by a test that does not inject it.
2. `we:skills-src/conveyor/review-daemon.mjs:500` — Add a shared `assertSafeBranchRef` (refuse a leading `-` and require the lane/ prefix) and call it from every function that passes a PR head ref to git. Enforce it with a check:standards rule that flags `headRefName` flowing into execFileSync or git without that call.
3. `we:scripts/conveyor/scope-bloat.mjs` — Add a deterministic recovery test spanning separate review and fix process state; retain the refresh result while retrying marker delivery independently.
4. `we:scripts/conveyor/scope-bloat.mjs` — Use NUL-delimited Git output and add a deterministic reader test comparing special-character paths with the literal PR paths.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4443@a2aa708b184b70017c2de52d0cac77f981636e73

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
