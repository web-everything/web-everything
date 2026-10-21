---
bornAs: xcdacup
kind: story
size: 2
status: open
scope: ["we:backlog/xg7whui-card-number-rename-after-land-batch.md"]
dateOpened: "2026-10-14"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5245 (head a503a16bd)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5245 (reviewed head `a503a16bd5038546ec4c4249a5e24bf62c3f5486`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:backlog/6126-card-number-rename-after-land-batch.md:70` — (edge-case, degraded) The rename plan does not preserve the previously published full canonical URL.
   - Scenario: Publish x7k2q9a-slug with ledger number 5301, bookmark /backlog/x7k2q9a-slug/, then apply the planned rename. An in-memory probe of the reused applyLedger core produces 5301-slug and stamps bornAs, but adds no formerSlugs entry. The existing backlogAliases loader consequently produces no old-stem redirect. Slice (b) specifies bare-number and bare-x-id redirects only, and leaves numeric cards unchanged. Thus the bookmarked full URL loses its page despite the epic's preservation guarantee. Record the old full stem in formerSlugs during materialization or explicitly generate equivalent redirects,
   - Claude's re-check: The epic promises that old /backlog/x7k2q9a-slug/ routes redirect after a rename. Slice (b) only adds /backlog/&lt;displayNum&gt;/ and /backlog/&lt;x-id&gt;/ redirects and leaves numeric cards unchanged. Slice (f) relies on those and specifies no formerSlugs entry or old-stem redirect, so the full old URL is lost.

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
