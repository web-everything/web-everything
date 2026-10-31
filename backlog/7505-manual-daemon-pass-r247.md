---
bornAs: xqs938p
kind: story
size: 5
status: open
scope: ["we:scripts/operations/manual-daemon-pass.mjs", "we:scripts/operations/manual-daemon-pass-io.mjs", "we:scripts/operations/run.mjs", "we:scripts/operations/__tests__/manual-daemon-pass.test.mjs", "we:docs/agent/testing.md"]
dateOpened: "2026-10-30"
tags: []
---

# manual-daemon-pass: run one daemon pass by hand (R247)

Adds the `manual-daemon-pass` operation (R247): when a review or red-team daemon is down, an operator runs exactly one pass by hand against one PR. It refuses a healthy daemon unless forced, refuses stale code, comments on the PR, and appends an audit event. `fix` and `verify` have no single-PR entry point yet and are refused.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/operations/__tests__/manual-daemon-pass.test.mjs` fails before and passes after (tests: refuses a healthy daemon before comment or dispatch; uses the shared staleness refusal and never comments or dispatches stale code; audits a dispatch error without repeating the pass).

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not run fix or verify passes (no single-PR entry point yet; follow-up cards), and does not restart daemons.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — PR number and flags are parsed strictly; the force flag is matched exactly.
2. **Truncated reads** — n/a: reads checkout HEAD only; an unreadable HEAD refuses.
3. **Shared state files** — one append-only JSONL audit event per attempt.
4. **Fail closed** — a launchctl read failure is not treated as a down daemon; stale code and healthy daemons refuse.
5. **Identity scoping** — the comment strips GH_TOKEN and GITHUB_TOKEN from the env; freshness is checked against this checkout.
6. **State over time** — the pass is never repeated after a dispatch error.
7. **Who wrote it** — n/a: the audit event records the daemon, PR, reason and checkout HEAD, not an operator identity.
