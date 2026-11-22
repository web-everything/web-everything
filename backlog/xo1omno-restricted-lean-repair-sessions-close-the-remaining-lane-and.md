---
kind: story
size: 3
status: open
scope: ["we:scripts/operations/dispatch-lane.mjs", "we:scripts/operations/dispatch-lane-io.mjs", "we:skills-src/conveyor/fix-agent-brief.md", "we:skills-src/conveyor/fix-agent-ci-brief.md", "we:scripts/guard-bash.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Restricted lean repair sessions: close the remaining lane and scratch access gaps

PR #7332 moved fix and ci-heal sessions to claude --restricted, which ignores user, project and local settings files and confines file tools to the working directories. That PR carries the lane grant in the launch argv. Self-review found five gaps outside its scope: (1) the tick payload in we:scripts/operations/dispatch-lane.mjs carries no repo, so laneRepoKey in we:scripts/operations/dispatch-lane-io.mjs falls back to scope order; (2) we:skills-src/conveyor/fix-agent-brief.md and we:skills-src/conveyor/fix-agent-ci-brief.md tell the agent to Write its evidence file under TMPDIR, which restricted file tools cannot reach; (3) laneRepoKey should use repoKeyForSlug from we:scripts/lib/constellation-repos.mjs (canonicalized) and fail closed on an unknown repo instead of defaulting to we; (4) a bare --bg --resume of a restricted session carries no flags, so confirm the CLI keeps --restricted and --add-dir on resume; (5) restricted mode drops the user-level ask rules and hooks (force-push, reset --hard, bypass env vars), so decide whether we:scripts/guard-bash.mjs or the lean --settings must carry them.

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
