---
bornAs: xpvw34x
kind: task
status: open
scope: ["we:scripts/lane-drain.mjs", "we:scripts/__tests__/lane-drain.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# lane-drain bornAs grep fails open

we:scripts/lane-drain.mjs:974 the bornAs grep fails open (class B). Source: build-queue 00:04 ET 2026-11-21.

## Acceptance

- [A1] **Executable** — Planned `refuses drain when bornAs grep fails` in `we:scripts/__tests__/lane-drain.test.mjs`: Make the real grep invocation fail in a repository fixture; assert drain refuses and performs no destructive drain action.
- [A2] **Executable** — Planned `distinguishes bornAs no-match from read error` in `we:scripts/__tests__/lane-drain.test.mjs`: Exercise an ordinary no-match result; assert it follows the documented no-match branch rather than the read-error refusal.

Run `npm run test:unit -- <test-files>` through the host heavy-run queue using the repository-relative paths after the `we:` prefixes above. These cases are planned; this card does not claim they already pass.

## Non-goals

- [N1] No unrelated drain or numbering changes.

## Edge cases this change must handle

1. **Untrusted text** — bornAs values remain data.
2. **Truncated reads** — Failed or partial grep output cannot authorize drain.
3. **Shared state files** — Leave drain state unchanged on read failure.
4. **Fail closed** — A grep execution error blocks drain with a visible reason.
5. **Identity scoping** — Inspect bornAs in the intended lane/card.
6. **State over time** — Retry only after obtaining fresh complete evidence.
7. **Who wrote it** — Command failure cannot masquerade as trusted absence.

## Duplicate admission

new-card-from-build-queue-CARD-line --json
