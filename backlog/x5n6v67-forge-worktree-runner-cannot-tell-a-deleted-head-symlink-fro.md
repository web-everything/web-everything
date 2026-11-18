---
kind: task
status: active
scaffoldedBy: "fix-7044"
dateScaffolded: "2026-11-18"
scope: ["we:scripts/readiness/forge-exec-bases.mjs", "we:scripts/readiness/forge-exec-run.mjs", "we:scripts/readiness/remote-exec.mjs"]
dateOpened: "2026-11-18"
tags: []
related: ["7044"]
---

# Forge worktree: runner cannot tell a deleted HEAD symlink from a projected alias without client link evidence

TODO digest — one ≤100-word paragraph: what this item does and why (replace this line).

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

## Duplicate admission

red-team break 3 on PR 7044: a staged symlink deletion plus an untracked real directory with matching bytes is restored as the HEAD link by materializeWorktree. The client refuses this today (we:scripts/readiness/__tests__/forge-head-symlink-change.test.mjs); the runner needs link evidence in the manifest (git.links with path+oid, a verifyManifest key allow-list change, a gitWorktree capability bump) to refuse it independently.
