---
bornAs: xpa7dc1
kind: story
size: 3
status: open
scope: ["we:scripts/readiness/__tests__/heavy-admission-run-ceiling.test.mjs"]
dateOpened: "2026-11-15"
tags: []
---

# heavy-admission-run-ceiling process-group timeout tests flaky in lane clones

The two process-group timeout tests in we:scripts/readiness/__tests__/heavy-admission-run-ceiling.test.mjs time out at 5 s and fail in lane clones under load, on main's we:scripts/readiness/heavy-admission.mjs too (seen 2026-11-15); they pass in the primary checkout. They red the full verify gate for unrelated PRs.

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
