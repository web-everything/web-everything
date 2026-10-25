---
bornAs: xmzttwc
kind: story
size: 1
status: open
scope: ["we:scripts/conveyor/health-watch.mjs", "we:scripts/conveyor/health-smells/__tests__/daemon-clone-wrong-branch.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Wire daemonCloneBranches probe into health-watch so daemon-clone-wrong-branch fires

The requested probe wiring already exists in this checkout, including isolation from fixture-mode health runs. Treat this as a stale work request pending disposition, not a new wiring change.

## Acceptance

- [A1] `t=we:scripts/conveyor/health-smells/__tests__/daemon-clone-wrong-branch.test.mjs; q=we:scripts/readiness/heavy-admission.mjs; node "${q#we:}" run -- npx vitest run "${t#we:}"` — Existing regression: the ops-branch fixture opens one high-severity episode per clone; main, lane, detached and unreadable clones are skipped. This is closure evidence, not a newly failing test.

## Non-goals

- [N1] No daemon checkout repair, branch switching, or new smell severity. No HTTP endpoint or reset trigger is introduced; body caps, rate limits and CSRF are inapplicable.

## Edge cases this change must handle

1. **Untrusted text** — Branch names remain data passed to git; never interpolate them into shell commands.
2. **Truncated reads** — An unreadable clone is skipped by the probe; do not describe that as proof that its branch is healthy.
3. **Shared state files** — Read clone HEADs only; leave health-watch episode persistence with its existing owner.
4. **Fail closed** — Preserve existing probe error handling; this diagnostic does not authorize a merge or a checkout repair.
5. **Identity scoping** — Key episodes by clone root and discover roots from the selected workspace; fixture roots must not probe the live workspace.
6. **State over time** — Repeated wrong-branch observations retain the same subject; a later healthy observation must stop reporting the breach.
7. **Who wrote it** — Branch discovery reports current state, not who changed it; no author attribution is inferred.

## Grounding

- we:scripts/conveyor/health-watch.mjs:85 imports the probe; line 1169 assigns daemonCloneBranches, with fixture-root suppression.
- we:scripts/conveyor/health-smells/__tests__/daemon-clone-wrong-branch.test.mjs:6 covers the episode; line 19 covers branch filtering.

## Open questions

STALE: the missing wiring is present. Should this card be closed as already shipped? The existing tests use injected git output, so they do not establish live daemon deployment or a real-clone end-to-end episode.
