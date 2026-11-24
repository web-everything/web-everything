---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:docs/agent/testing.md", "we:skills-src/conveyor/review-daemon.mjs", "we:scripts/operations/pr-sweep-core.mjs", "we:scripts/operations/review-dispatch.mjs", "we:scripts/operations/review-job.mjs", "we:docs/agent/delivery-loop.md", "we:skills-src/conveyor/__tests__/review-daemon.test.mjs", "we:scripts/operations/__tests__/pr-sweep-core.test.mjs", "we:scripts/operations/__tests__/review-dispatch.test.mjs", "we:scripts/operations/__tests__/review-job.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Add a check:standards rule that any documented we:scripts/operations/review-dispatch.mjs, we:scri… (from web-everything/web-everything#7430 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:docs/agent/testing.md:3917` — Add a check:standards rule that any documented `we:scripts/operations/review-dispatch.mjs`, `we:scripts/operations/review-job.mjs run` or `manual-daemon-pass --daemon=review|red-team` command includes `--expected-head`.
2. `we:skills-src/conveyor/review-daemon.mjs:2207` — Add an onTick test that feeds `refused` and `attention` rows and asserts both log lines.
3. `we:skills-src/conveyor/review-daemon.mjs:866` — Extend the refusal test with a second planned review and one acquirable lane, and assert the second one is dispatched.
4. `we:scripts/operations/pr-sweep-core.mjs:213` — Add a test that parses each nextActions command and asserts review-job commands carry the PR's head SHA.
5. `we:scripts/operations/review-dispatch.mjs:779` — Add a child-process test of `we:scripts/operations/review-dispatch.mjs` in job mode: no pin exits 75, and a pin reaches dispatchReviewJob (stubbed gh). More generally, require a real-argv test for each new CLI flag. File as a backlog card.
6. `we:skills-src/conveyor/review-daemon.mjs:2207` — Add an onTick test with an injected logger asserting the ATTENTION line for a result carrying `attention`. File as a backlog card.
7. `we:scripts/operations/review-job.mjs:709` — Pass timeout and maxBuffer in liveHead, and add a check:standards rule requiring a timeout on synchronous `gh` execs in daemon-reachable modules. File as a backlog card.
8. `we:docs/agent/delivery-loop.md:166` — A check:standards rule that flags documented `we:scripts/operations/review-dispatch.mjs` or `manual-daemon-pass --daemon=review|red-team` commands lacking `--expected-head`. File as a backlog card.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7430@0826abf5f83927a5d6bfe9b4353e02837f83b0fd

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
