---
bornAs: xowzo8m
kind: story
size: 2
status: open
scope: ["we:scripts/lib/push-gate-lint.mjs", "we:scripts/__tests__/push-gate-boundary.test.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# push-gate-lint valued-option spread (F4) and RS-7369-3 test-coverage follow-ups from we#7515/#7490

F4: we:scripts/lib/push-gate-lint.mjs:120 skips a spread in a valued global-option slot (if (valued.has(word)) { i += 2; continue; } never checks args[i+1]). Fix: return null when args[i+1] is a spread; test ['-C', ...p, 'rev-parse']. Tripwire only (boundary is we:scripts/authorized-push.mjs), not merge-path; folded into plan step PUSH-GATE-LINT-PINS. Also the test-coverage follow-ups reviewers raised on we#7515/#7490 (plan step RS-7369-3, build-queue #41): CLI/loader edge-SHA parity in we:scripts/daemon-overlay.mjs, waiver-precedence cases in we:scripts/lib/overlay-audit-evidence.mjs, warn-mode auditedSha absent test. Held item 416, filed under operator ruling 2026-11-27 13:18 ET (blocks we#7515 referral gate).

## Acceptance

- [A1] **Executable** — `node --test we:scripts/__tests__/push-gate-boundary.test.mjs` fails on the new case `['-C', ...p, 'rev-parse']` (lint must return null) before the fix and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change the push boundary in we:scripts/authorized-push.mjs; the lint is a tripwire only, not merge-path.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the spread element is argv text; the fix treats any spread as unparseable (return null).
2. **Truncated reads** — n/a: no file reads in the lint.
3. **Shared state files** — n/a: no shared state written.
4. **Fail closed** — a spread in a valued option slot returns null (cannot prove safe).
5. **Identity scoping** — n/a: no identity involved.
6. **State over time** — n/a: pure function of its argv.
7. **Who wrote it** — n/a: tripwire applies to any caller.
