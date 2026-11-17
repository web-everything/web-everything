---
kind: story
size: 5
parent: "8382"
status: open
scope: ["we:scripts/operations", "we:scripts/lib", "we:scripts/conveyor"]
dateOpened: "2026-11-16"
tags: []
---

# Multi-profile sessions S2b: IO callers use the store model

S2b of the multi-profile sessions design (parent 8382): IO callers (we:scripts/operations/session-role.mjs, we:scripts/operations/dispatch-lane-io.mjs, we:scripts/operations/dispatch-abort.mjs, we:scripts/operations/wake.mjs, we:scripts/lib/claude-agents-cache.mjs, we:scripts/conveyor/stuck-pr-watch.mjs, we:scripts/conveyor/session-reaper.mjs, we:scripts/conveyor/lease-reaper.mjs, we:scripts/conveyor/fixer-stuck-reclaim.mjs, we:scripts/conveyor/await-verify-pass.mjs, we:scripts/conveyor/orphan-claim-release.mjs) use the claude-stores model with table-driven ok/unknown/ambiguous tests. The hung-session reader is deferred until #6911 merges.

## Acceptance

- [A1] **Executable** — the scoped node --test run over the S2b callers' table-driven tests (ok / unknown / ambiguous per caller) fails before this item lands and passes after.
- [A2] **Must** — an unknown or ambiguous store read refuses to stop, release or reap (fail closed); only an ok store may claim a session is gone.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not touch the hung-session reader (held by #6911), the 15 other readers (S3), or the accountB switch (stays OFF).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: no new text parsing beyond the store model.
2. **Truncated reads** — an unreadable or non-array listing makes the store invalid, so the aggregate is unknown.
3. **Shared state files** — n/a: no new shared files; cache keyed by store.
4. **Fail closed** — unknown/ambiguous throw or skip, never release.
5. **Identity scoping** — each stop runs in the owning store env.
6. **State over time** — fast path keeps main's behavior with one store.
7. **Who wrote it** — n/a: local CLI output only.
