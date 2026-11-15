---
bornAs: xpnv7aq
kind: story
size: 3
status: open
dateOpened: "2026-11-15"
tags: []
---

# Fix the remaining ~21 test files blocked by the Forge bundle credential scan, and handle historic blobs in the range

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

#6894/#6895 fixed 20 files; this covers the rest plus the history-range cause

## Remaining scope (filed by fixture-token-deflake)

Two causes of `bundle-credential-hit` on test files:

1. Head blobs that still hold token-shaped literals (the scanner decodes `\x` escapes, so `gh\x70_...` is still a hit). Fix: split the literal with concatenation. Still blocked after #6894/#6895, all under we:scripts/ or we:skills-src/ `__tests__`: lane-pool-hooks-path, learnings-drop, learnings-harvest, card-number-ledger, github-app-identity, agent-command-audit, command-redact, completion-record, completion-record-v2, coroner-extract, coroner-sample, file-held-cards, worker-result, worker-result-router, worker-wrapper, forge-flagged-name-rule, usage-report, build-dispatch-daemon, build-dispatch-non-blocking-launch, launchd-templates, review-daemon (plus the three in #6880: ci-heal-mark, coroner-transcripts, git-bundle-transport).
2. Historic blobs: the bundle scan reads every commit added after the runner base. we:scripts/conveyor/__tests__/ci-red-recovery-watch.test.mjs is clean at head since 2026-11-14 05:19 ET (#6719), but about 10 older commits of it hold a literal, so a runner base older than that still blocks. Fix the cause (fresher runner base, or scan only the head tree for a base-reachable range), not the fixture.

A sweep of all tracked files with credentialBufferFinding, credentialContentFinding and manifestEntry finds these.
