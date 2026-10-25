---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# Drain: ~71 s per pass is untimed, and branch numbering likely throws its cache away

[held entry 315] (daemon-async-audit 2026-10-14, held — relates x4q84y2) Drain: ~71 s per pass is untimed, and branch numbering likely throws its cache away. The residual (p50 71 s, p90 143 s, max 556 s) is likely a per-candidate serial git fetch plus net-diff basis (we:merge-ai-prs.mjs:5427 → :3719). Numbering takes 31 s p50 / 65 s p90 inside the merge step. Its visible-hash cache path comes from git rev-parse --git-path inside a temp worktree (we:lane-drain.mjs:1020), probably per-worktree, so rev-list is redone each run (UNTESTED). The ledger shadow (64 MB read) runs after the pass total is taken (:6956). Fix idea: timer steps for escalation, drainOrder, freeze and ledger; one batched fetch per pass + a net-diff cache keyed by (main SHA, head SHA); cache path from --git-common-dir; then numbering as a detached job. Design: cache + async job. Evidence: plateau-app/.drain-daemon/daemon.log pass timings (68 passes). Saves 50–130 s/pass. Size 3.

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
