---
bornAs: x4j8zwx
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/health-watch.mjs", "we:scripts/conveyor/review-tmp-health.mjs", "we:scripts/conveyor/__tests__/review-tmp-health.test.mjs", "we:scripts/operations/__tests__/review-scratch-cleanup.test.mjs", "we:scripts/conveyor/__tests__/health-watch.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — Add a tick() integration test that injects a low-disk probe, a temporary feed path and a temporar… (from web-everything/web-everything#5468 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/health-watch.mjs:1358` — Add a tick() integration test that injects a low-disk probe, a temporary feed path and a temporary tmp root. Assert that the feed gets a NEEDS-YOU line and that an expired seat dir is removed.
2. `we:scripts/conveyor/review-tmp-health.mjs:23` — Add a test with an injectable busy reader (or a PATH-stubbed lsof) that fails. Assert that nothing is deleted and that the cache cap still runs.
3. `we:scripts/conveyor/review-tmp-health.mjs:23` — Define the ephemeral review prefixes in one shared constant, consumed by both the backlog-index bypass and the sweeper. Add a test that asserts every mkdtemp prefix in we:review-extra-seats.mjs is swept.
4. `we:scripts/conveyor/review-tmp-health.mjs:27` — Add a test or lint that collects every `mkdtemp*(…'we-…-')` prefix used under scripts/ and asserts each is covered by the sweeper allowlist or an explicit exemption.
5. `we:scripts/conveyor/__tests__/review-tmp-health.test.mjs:11` — Add deterministic regression tests that force cwd observation failure and create symlink fixtures, asserting checkout preservation, cache eviction, and unchanged external targets.
6. `we:scripts/conveyor/__tests__/review-tmp-health.test.mjs:55` — Add a deterministic health-watch integration test asserting one feed append on opening and no duplicate append on a continuing episode.
7. `we:scripts/conveyor/__tests__/review-tmp-health.test.mjs:11` — Add deterministic sweep tests for failed cwd observation and top-level and nested symlinks, with assertions on retained paths and external target contents.
8. `we:scripts/operations/__tests__/review-scratch-cleanup.test.mjs:10` — Make the existing child-process test assert scratch removal before process exit, so the exit hook cannot compensate for a missing failure-path cleanup.
9. `we:scripts/conveyor/__tests__/review-tmp-health.test.mjs:55` — Add a deterministic tick integration test with an intercepted feed writer, asserting one disk-space entry on opening and no duplicate on a continuing episode.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5468@ac7e0178833dea01319068ba0943a9269c831c25

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
