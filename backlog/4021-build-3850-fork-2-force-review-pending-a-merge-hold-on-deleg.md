---
bornAs: x2h4jmq
kind: story
size: 3
parent: "3383"
status: resolved
scaffoldedBy: "close-3784"
dateScaffolded: "2026-09-23"
scope: ["we:scripts/lib/dispatch-contracts.mjs", "we:scripts/operations/dispatch-lane.mjs", "we:docs/agent/platform-decisions.md"]
dateOpened: "2026-09-23"
dateResolved: "2026-09-24"
graduatedTo: none
tags: []
---

# Build #3850 Fork 2: force review:pending / a merge hold on delegated routes at the land seam

#3850's Fork 2 was ratified 2026-09-22 (every route whose executed vendor is not Claude gets a dispatch-time hold, then a merge hold at the land seam requiring independent review before landing) but only Fork 1 (naming a supervisor so a well-formed dispatch is never held at spawn) was ever built, as part of #3784's own scope. Fork 2 -- forcing review:pending or an equivalent merge hold on a delegated route at the land seam -- has no code and no tracking item. Needed before #3443 graduates the branch to main, since without it a delegated (non-Claude) dispatch that clears spot-check has no independent look before landing.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

> **Verified done, 2026-09-24.** Built and committed to `lane/mechanical-dispatcher` at `d0440d1bc`
> (tracker note appended in the same push). The land-seam merge hold on delegated (non-Claude-executed)
> routes is live for `build` (`we:scripts/operations/deliver-item-wrapper.mjs`'s `decideParkMode` forces
> `review:pending` when the real `executedVendor` isn't Claude) and `fix` (already covered — a `fix`
> only ever targets a PR already carrying `review:changes`/`review:human`, so the existing
> vendor-agnostic re-arm already holds it). 34 new tests, 289 passing across the four touched suites,
> `check:standards` 0 errors. Both directions tested: a Claude-executed route never trips the hold; a
> non-Claude-executed route is held.
>
> **Residual gap, named not fixed:** `ci-heal` gets the data half only —
> `we:scripts/conveyor/ci-heal-mark.mjs` now stamps the real executed vendor into its durable comment,
> but the actual land-time refusal (wiring this into `we:scripts/conveyor/merge-ai-prs.mjs`'s
> `decideReviewGate`) was deliberately deferred, mirroring this repo's own #3493 precedent (a
> built-and-tested gate predicate, held back from a live call site until wired) rather than a blind edit
> to a ~4,000-line production merge gate. Filed as its own item so it doesn't get lost: bornAs `4032`.
>
> Resolved here as `graduatedTo: none` — the code is not yet on `main`; it reaches `main` through #3443.
