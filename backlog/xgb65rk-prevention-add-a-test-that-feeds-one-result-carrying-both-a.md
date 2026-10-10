---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-self-sync.mjs", "we:scripts/lib/__tests__/daemon-deps-job.test.mjs", "we:scripts/lib/daemon-rebuild/deps-job.mjs", "we:backlog/5691-builder-and-fix-daemons-and-the-drain-s-data-clone-npm-ci-ad.md", "we:scripts/lib/__tests__/daemon-self-sync.test.mjs", "we:scripts/lib/daemon-rebuild/__tests__/deps-job.test.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Prevention — Add a test that feeds one result carrying both a clone-recloned finishedJob and a rebuild-job-sta… (from web-everything/web-everything#4794 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-self-sync.mjs:770` — Add a test that feeds one result carrying both a clone-recloned finishedJob and a rebuild-job-started job, with a real-store-shaped rebuildJobIds. Better, exclude result.job.id from staleJobIds in noteReclone when the same result reports rebuild-job-started.
2. `we:scripts/lib/__tests__/daemon-deps-job.test.mjs:1` — Add a test that runs `runDepsJob` or `installStep` with the default installer and a spy `exec`, asserting the argv. Cheaper still: make `install` a required parameter of `installStep`, with the single production call site in `runDepsJob` passing `depsJobInstaller()`.
3. `we:scripts/lib/daemon-rebuild/deps-job.mjs:181` — A lint rule (e.g., from `eslint-plugin-sonarjs`) against invoking the same side-effectful or expensive function multiple times in the same synchronous block.
4. `we:backlog/5691-builder-and-fix-daemons-and-the-drain-s-data-clone-npm-ci-ad.md:1` — A PR template or submit-gate check ensuring backlog cards contain required headings like 'Risks' and 'Test plan'.
5. `we:scripts/lib/daemon-self-sync.mjs` — A unit test asserting that recloneConcluded fails closed (returns false for any finished job) when given UNREADABLE_RECLONE_MARKER, and updating the existing corrupt-marker test to expect it to block.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4794@22a55204f4cecec48bb1cbc8c06239d8f48650d6

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
