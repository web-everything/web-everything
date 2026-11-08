---
bornAs: xd9uqu3
kind: story
size: 2
status: open
related: ["2393"]
scope: ["we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# blockedBy edge clears by absence, so a dependent lands when its blocker PR was closed unmerged (stackParents …

Flow-sim gap R5c-G4, class K18 (state keyed to an identity never checked for liveness or retraction). Failing input: Dependent D (manifest blockedBy:[N], ready-to-merge, accepted, green). Blocker item N had an open PR that is then CLOSED without merging (abandoned, superseded, or never opened because the item is not built). 'Next drain cascade pass. Cited: we:scripts/merge-ai-prs.mjs:2622, we:scripts/merge-ai-prs.mjs:2688, we:scripts/merge-ai-prs.mjs:2714-2715. Soak-break sketch: Fixture: candidates [D{item:2,blockedBy:[1]}], no candidate/extra item 1, provenOnMain empty, item 1 not landed on main. Action: orderCascade/planLandings for a full sweep. Assertion that fails today: D is in `deferred` with a waitOn naming 1 (needs an 'absen…

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
