---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/urgent-verify.mjs", "we:scripts/operations/__tests__/urgent-verify.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Under URGENT-VERIFY-GRACEFUL, send TERM, wait a bounded grace period, then KILL, with a test whos… (from web-everything/web-everything#7455 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/urgent-verify.mjs:20` — Under URGENT-VERIFY-GRACEFUL, send TERM, wait a bounded grace period, then KILL, with a test whose child records that its TERM handler ran on both cancel and expiry. Make sure that card is actually filed.
2. `we:scripts/operations/urgent-verify.mjs:74` — Floor the remaining time (minimum 1) before passing it to spawnSync, and add a unit test with a non-integral limit that asserts Number.isInteger(timeout).
3. `we:scripts/operations/__tests__/urgent-verify.test.mjs` — Add an integration test that runs real vitest on one finishing and one hanging fixture under a short deadline and asserts hungFiles, or require the live run's receipt on the PR.
4. `we:scripts/operations/urgent-verify.mjs:63` — Add a real-process test in 'urgent-verify real process-tree expiry' where the fixture does process.kill(process.ppid, 'SIGKILL') and assert standards() throws. As a class guard, require every 'fail closed' comment in protected-path files to name its test.
5. `we:scripts/operations/__tests__/urgent-verify.test.mjs` — Have the card template mark each acceptance item as either a named test or a manual check with recorded evidence, and scope 'naming a file' to grouped unit shards.
6. `we:scripts/operations/urgent-verify.mjs:45` — Reuse the independent detached watchdog pattern in we:heavy-admission.mjs execWithRunCeiling (outside both groups), and add a real-process test that group-SIGKILLs the runner and asserts the command group dies.
7. `we:scripts/operations/urgent-verify.mjs:34` — Send TERM, wait a bounded grace period, then SIGKILL, with a real-process test asserting a TERM handler in the fixture wrapper runs on cancellation. File or confirm the URGENT-VERIFY-GRACEFUL card.
8. `we:scripts/operations/urgent-verify.mjs:249` — Add a deterministic regression test with overlapping assigned paths that asserts the exact hungFiles list and total after only the longer path completes.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7455@97e5ab47de5e212d76f385d2ece84b442295597d

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
