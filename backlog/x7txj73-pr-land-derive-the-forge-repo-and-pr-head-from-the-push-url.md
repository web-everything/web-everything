---
kind: task
status: open
scope: ["we:scripts/pr-land.mjs", "we:scripts/__tests__/pr-land-preflight.test.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# pr-land: derive the forge repo and PR head from the push URL when pushurl differs from url

Self-review on PR #7307 found that we:scripts/pr-land.mjs publishes the lane ref to the push URL (remote.origin.pushurl) but resolves the forge repo slug from the fetch URL and lists or creates the PR by bare head through gh's cwd-resolved repo (a hard-coded origin read too). With pushurl=fork and url=upstream, PR list/create act on upstream, whose lane branch may hold an unrelated tip, so a wrong-head PR can be created or bound before assertPrHeadMatches refuses the label and land. Pre-existing, not introduced by #7307; nothing lands, but a stray PR can open. Fix: derive the forge repo and owner:branch head from the resolved push URL, or refuse PR create when the push and fetch repos differ; add a real-remote test with url=upstream, pushurl=fork.

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
