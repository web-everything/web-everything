---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/dispatch-smoke-launch.mjs", "we:scripts/lib/daemon-boot-smoke.mjs", "we:scripts/lib/__tests__/daemon-boot-smoke.test.mjs", "we:scripts/lib/__tests__/daemon-load-overlay.test.mjs", "we:scripts/lib/__tests__/dispatch-smoke-launch.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — Add a smoke-harness integration test that spawns the real we:scripts/lib/dispatch-smoke-launch.mj… (from web-everything/web-everything#5460 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/dispatch-smoke-launch.mjs:33` — Add a smoke-harness integration test that spawns the real `we:scripts/lib/dispatch-smoke-launch.mjs` against a stub tree.
2. `we:scripts/lib/daemon-boot-smoke.mjs:205` — Add a `writeStderrTail` retention test with a lowered, injectable KEEP. More generally, add a check:standards rule that every numeric cap named in docs/agent/*.md has a test referencing it.
3. `we:scripts/lib/daemon-boot-smoke.mjs:259` — Share one retry-count validator with a documented max (such as the dispatch 0–1 rule), and add a test that an out-of-range value falls back to the default.
4. `we:scripts/lib/__tests__/daemon-boot-smoke.test.mjs` — Add a deterministic scheduling regression test using multiple entries and a nondefault concurrency limit.
5. `we:scripts/lib/daemon-boot-smoke.mjs` — Add a deterministic threshold-crossing retention test that asserts both the count and which files survive.
6. `we:scripts/lib/__tests__/daemon-load-overlay.test.mjs` — Add a deterministic no-output regression test asserting null at the result and alert boundaries.
7. `we:scripts/lib/daemon-boot-smoke.mjs` — Extend the injected-result regression test with quoted sentinel text and assert its absence from every persisted alert sink.
8. `we:scripts/lib/__tests__/daemon-boot-smoke.test.mjs` — Add deterministic filesystem regression tests asserting the exact retained files and that a symlink target is never read.
9. `we:scripts/lib/__tests__/daemon-boot-smoke.test.mjs` — Add deterministic injected-child tests asserting maximum simultaneous children and exact attempt counts for nondefault settings.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5460@3db723965ef713533c7a7c051ed10a505801ef2a

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
