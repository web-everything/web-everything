---
bornAs: x193gp4
kind: task
status: active
scaffoldedBy: "fix-6213"
dateScaffolded: "2026-11-02"
scope: ["we:scripts/lib/daemon-rebuild/lease.mjs", "we:scripts/lib/daemon-rebuild/candidate.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# claimBuildLease: validate state.building.path is under the state dir candidate prefix before removeCandidate deletes it

Found in PR 6213 self-review (pre-existing). removeCandidate in we:scripts/lib/daemon-rebuild/candidate.mjs runs git worktree remove --force and rmSync recursive on state.building.path from the JSON state file with no check that it sits under stateDir with the cloneKey.candidate- prefix (reclaimStaleCandidates validates this). A corrupt lease with a dead pid and a foreign path would delete that path. Fix: validate in claimBuildLease in we:scripts/lib/daemon-rebuild/lease.mjs or in removeCandidate; test with a foreign path.

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
