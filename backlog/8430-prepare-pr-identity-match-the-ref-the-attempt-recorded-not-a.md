---
bornAs: x3c1wog
kind: story
size: 3
status: active
scaffoldedBy: "fix-5366"
dateScaffolded: "2026-10-15"
scope: ["we:scripts/conveyor/prepare-pr-match.mjs", "we:skills-src/conveyor/build-dispatch-daemon.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Prepare PR identity: match the ref the attempt recorded, not a lane/<num>-prepare- name pattern

The write-grade prepare PR match (status reader, retirement, stamp recovery) accepts any same-repo lane/<num>[a-z]?-prepare- branch. Build branches are lane/<num><tag>-<slug> with the slug from the card title, so a card titled 'prepare ...' gets a build branch that matches (live: PR #5138, lane/4385-prepare-rule-mvp-cut). Today a build head's card carries its prepare stamp, which blocks stamp recovery, but claim retirement on 'prepare PR merged/closed' can still read a build PR. Four places judge the same identity with different patterns (we:scripts/conveyor/prepare-pr-match.mjs -prepare-, the refusal probe's lane/ prefix in we:skills-src/conveyor/build-dispatch-daemon.mjs, we:scripts/operations/prepare-pr.mjs -prepare-item-, we:scripts/conveyor/build-delivery-evidence.mjs (scope|prepare)). Fix: record the attempt's ref on the claim/run row and match against it; keep the name pattern as refusal grade only. Surfaced by the PR #5366 round-7 self-review; pre-existing on main.

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
