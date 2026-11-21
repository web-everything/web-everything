---
bornAs: xdszwjr
kind: task
status: open
scope: ["we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Fix daemon should ask once then fall back to a worker takeover instead of refusing forever

#7227: the fixer stood down asking a question and the daemon refuses redispatch until the operator answers. It should ask once, then fall back to a worker takeover (R90). Source: build-queue 03:26 ET 2026-11-21.

## Acceptance

- [A1] **Executable** — Planned `asks once after fixer stands down then permits takeover` in `we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs`: Replay repeated ticks after a fixer stands down; assert exactly one question and subsequent worker takeover without repeated prompts or indefinite refusal.

Run `npm run test:unit -- <test-files>` through the host heavy-run queue using the repository-relative paths after the `we:` prefixes above. These cases are planned; this card does not claim they already pass.

## Non-goals

- [N1] No bypass of explicit human-required restrictions.

## Edge cases this change must handle

1. **Untrusted text** — Question text is data.
2. **Truncated reads** — Incomplete stand-down evidence cannot authorize takeover.
3. **Shared state files** — Persist ask-once state without duplicate takeover.
4. **Fail closed** — Unclear takeover eligibility holds with a visible reason.
5. **Identity scoping** — Bind the question and takeover to the same PR/run.
6. **State over time** — Cover repeated ticks and daemon restart.
7. **Who wrote it** — Only recorded fixer/daemon state permits takeover.

## Duplicate admission

nd
