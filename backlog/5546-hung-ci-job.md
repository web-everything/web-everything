---
bornAs: xncfkf2
kind: story
size: 5
parent: "3383"
status: open
scope: ["we:scripts/conveyor/ci-queue-watch.mjs", "we:scripts/conveyor/__tests__/ci-queue-watch.test.mjs", "we:scripts/conveyor/health-smells/ci-job-hung.mjs", "we:scripts/conveyor/health-smells/__tests__/ci-job-hung.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Hung CI job watch: cancel and re-run a check stuck in_progress past k x p95, escalate a second hang

Live 2026-10-08: PR #4450's required daemon-soak check sat in_progress 90+ min (GitHub reports the job status in_progress though all its steps finished and completed_at is set). Nothing noticed; the PR would wait for GitHub's 6h job timeout. Fix: ci-queue-watch sweep reads open PRs' check rollups, learns each check's recent successful durations (rolling p95), flags a check in_progress longer than max(floor, k x p95) as hung, cancels its run if still running and re-runs the job once via the App token through gh-throttle, records it; a second hang on the same head logs an escalation that the ci-job-hung health smell raises as [high].

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
