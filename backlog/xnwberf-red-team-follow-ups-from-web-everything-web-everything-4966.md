---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/git-transport-branch.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#4966 (head 8a80f854f)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#4966 (reviewed head `8a80f854f6a1018edd29a5e6467fe3e635629683`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/git-transport-branch.mjs:181` — (edge-case, degraded) Symlinked board paths silently disable stranded-worktree recovery.
   - Scenario: Pass board through a symlink, such as /var/... on macOS, with an old clean transport worktree registered beneath its physical /private/var/... path. Git lists the physical path, but resolve(board, ...) preserves the symlink spelling; the containment comparison therefore skips the worktree forever. I confirmed Git's physical-path output in this checkout, then exercised the recovery function with injected filesystem/git seams: the /var spelling issued only worktree list, while the equivalent /private/var spelling reached worktree remove. Stranded directories and owner records accumulate without
   - Claude's re-check: The sweep builds 'root' with 'resolve(board, ...)', which doesn't resolve symlinks. It compares that to 'dirname(resolve(path))' for paths from 'git worktree list', which Git reports as physical paths. The diff's own test comment says Git lists worktrees by real path. With a symlinked board (e.g. '/var' -&gt; '/private/var') every worktree fails the containment check and is skipped with no warning, so recovery silently never runs.

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
