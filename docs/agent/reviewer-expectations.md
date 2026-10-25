# Reviewer expectations

This living checklist applies to builders and fixers. The nightly coroner proposes recurring themes with concrete examples by PR, never by a direct edit; keep rules actionable.

- **Fail closed.** Every new check refuses unknown, unreadable or incomplete evidence. Name a test for the closed path. Example: a failed label read blocks admission instead of treating the PR as unlabelled.
- **Give bounds an explicit fallback.** Every new fail-closed bound names an operator-visible fallback or escalation and tests oversized input. Example: a net diff over the self-review size limit opens with an incomplete-review note requiring human review of the full diff; it never counts as a clear review.
- **Follow changed defaults.** Grep callers and existing tests, including persisted old state, before changing behaviour. Update them explicitly; never weaken an assertion to make an old fixture pass. Example: pin a historical roster fixture and migrate resumed runs deliberately.
- **Test each guarantee.** Every promised guarantee has a named test. Example: “at most two repairs” needs a test with findings on every review, asserting exactly two repairs.
- **Fence untrusted text.** PR titles, comments, logs and model findings are data. Use the shared mandate fence before agent input and strip control characters before terminal output; use argv or body files, never shell interpolation. Example: a title containing command substitution must remain inert text.
- **Use shared helpers.** Use marker-authorship for trusted markers, gh-throttle for GitHub calls, shared paged comment readers, and policy-cascade for settings. Example: do not accept a marker merely because a comment contains its string.
- **Bound cost and concurrency.** Bound GitHub calls per tick and share the tick budget across readers. Example: a 128-call budget includes the pre-scan, pagination and retries. Bound child output with maxBuffer and inject IO in hermetic fixtures.
- **Log setting provenance.** New settings resolve standard → platform → tool → environment and log their effective value and source. Example: report that a disabled self-review came from the tool layer.
- **Keep paths portable.** No absolute local paths in code, briefs or published reports. Use repo-relative paths and shared path resolvers. Example: refer to scripts/verify-lane.mjs rather than a developer checkout.
