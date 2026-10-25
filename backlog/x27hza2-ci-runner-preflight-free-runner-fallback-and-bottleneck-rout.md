---
kind: story
size: 3
status: open
scope: ["we:.github/workflows/ci.yml", "we:scripts/ci"]
dateOpened: "2026-10-25"
tags: []
---

# CI runner preflight, free-runner fallback and bottleneck routing

2026-10-24 15:03-16:34 ET: WE_SHARD_RUNNER=we-8core froze every test-shard job because the Default runner group had allows_public_repositories=false (repo is public); sweep 16:26 ET saw #5759 #5762 #5806 #5839 #5849 #5859 stuck. Want: (a) runner-setup asserts the group allows the repo before setting the var; (b) CI falls back to ubuntu-latest when a larger-runner job stays queued over 10 min; (c) hung-CI recovery re-triggers on the current head when the run 404s instead of cancel-failed retry-capping. Later (operator 16:59 ET 'Not for now but for later'): route by bottleneck - merge-queue runs (gh-readonly-queue/*) always we-8core, ordinary PR runs ubuntu-latest, the daemon flips PR runs to we-8core when queued runs exceed ~8 or PRs wait on CI over 15 min, thresholds as cascade settings. One PR.

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
