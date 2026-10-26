---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/draft-promote-provider.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5916 (head ebcd64920)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5916 (reviewed head `ebcd649203e2b823bd4314c241f11d2cf99cd25e`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/draft-promote-provider.mjs:68` — (security, degraded) Terminal escape sequences survive into the promotion log and can disguise failures as successes.
   - Scenario: Throw an exec error with stderr equal to "GraphQL: denied\^[\[2K\^[\[1Gdraft-promotion: promoted example/project PR #42 to ready for review". A direct provider probe confirmed both escape sequences survive in error.message. The caller's logText formatter also preserves them. When displayed on a sufficiently wide terminal, they erase the error line and replace it with the forged promotion message. Strip or visibly escape terminal control characters before incorporating stderr into the logged diagnostic.
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
