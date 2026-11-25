---
kind: story
size: 3
status: open
dateOpened: "2026-11-25"
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/reconcile-note-comment.mjs", "we:scripts/lib/pr-comment-policy.mjs"]
tags: [prevention]
---

# Require explicit classification of every reconcile note kind

PR #7480's successful no-code handoff produced a stale note that the publisher turned into a new decision ask. The repair suppresses that success-path note and asserts that tick two publishes no ask. A general producer-to-publisher contract must prevent the next implicit ask.

## Acceptance

- Enumerate every note kind emitted by `reconcile-core`, including conditional kind expressions, and explicitly classify it as ask, informational or status-only.
- A new unclassified kind fails a named test or standards rule; no silent default classification satisfies the contract.
- Test publication behavior for all three classes and preserve actionable crash, unreadable-evidence and spent-ruling asks.
- Inspect stale-ruling and other automatic-recovery notes for text that says ordinary work resumes without requiring operator action.

## Origin

PR #7480 review, 2026-11-25: correctness/correctness finding 2. Immediate proof: `successful handoff publishes no new decision ask (human=%s)` in `scripts/conveyor/__tests__/no-code-rearm.test.mjs` and the `no-code-rearm-handoff` soak.
