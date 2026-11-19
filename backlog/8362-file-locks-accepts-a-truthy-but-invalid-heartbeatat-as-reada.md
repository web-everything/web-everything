---
bornAs: xjssqwv
kind: story
size: 3
status: open
scope: ["we:scripts/readiness/file-locks.mjs"]
dateOpened: "2026-11-15"
tags: []
---

# file-locks accepts a truthy-but-invalid heartbeatAt as readable

we:scripts/readiness/file-locks.mjs accepts a truthy but invalid heartbeatAt as a readable entry and then treats the lease as expired, so malformed slot evidence can be reclaimed instead of failing closed as remote-slot-unreadable. Found by the round-2 Codex audit of lane/forge-health-unreadable; pre-existing, not introduced there.

## Acceptance

- [A1] **Executable** — the card's named test file runs green under `npm run test:unit` in a lane clone under load.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] n/a: nothing excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: test or lock-validation change only; no new input surface.
2. **Truncated reads** — n/a: test or lock-validation change only; no new input surface.
3. **Shared state files** — n/a: test or lock-validation change only; no new input surface.
4. **Fail closed** — n/a: test or lock-validation change only; no new input surface.
5. **Identity scoping** — n/a: test or lock-validation change only; no new input surface.
6. **State over time** — n/a: test or lock-validation change only; no new input surface.
7. **Who wrote it** — n/a: test or lock-validation change only; no new input surface.
