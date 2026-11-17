---
bornAs: x9wo9jh
kind: story
size: 2
status: active
scaffoldedBy: "fix-6319"
dateScaffolded: "2026-11-05"
scope: ["we:scripts/lane-pool.mjs"]
dateOpened: "2026-11-05"
tags: []
---

# Lane git-config scrub refuses a redirected git dir before writing (acquire, refresh, reclaim)

scrubClaimedLaneConfig runs git config --local writes in a lane at acquire hand-out, sibling and refresh fetch, salvage and reclaim reset. A lane-written .git/commondir (or a .git gitfile/symlink) makes those writes edit another repository's config, e.g. strip the operator primary's credential/http/include keys. PR #6319 added releaseGitDirRedirect and refuses release before any work; reuse it so every scrub site refuses (or skips with a loud journal line) when the lane does not own its git dir, with a test per site against a commondir decoy asserting the decoy config is unchanged.

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
