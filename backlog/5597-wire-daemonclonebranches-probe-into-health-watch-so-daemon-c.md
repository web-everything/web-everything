---
bornAs: xmzttwc
kind: story
size: 1
status: open
scope: ["we:scripts/conveyor/health-watch.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Wire daemonCloneBranches probe into health-watch so daemon-clone-wrong-branch fires

The daemon-clone-wrong-branch smell (high) and its probe we:scripts/lib/daemon-clone-branch-probe.mjs landed with the 2026-10-09 review-daemon outage fix, but we:scripts/conveyor/health-watch.mjs was held by PR #4461, so the one-line wiring is owed: probes.daemonCloneBranches = attempt('daemonCloneBranches', () => probeDaemonCloneBranches({ workspace: workspaceOf(REPO_ROOT) })). Until it lands the smell evaluates an empty probe. Prove live: a fixture clone on ops/* opens the episode.

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
