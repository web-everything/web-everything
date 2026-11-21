---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:vitest.real.config.ts", "we:.github/workflows/real-tests.yml", "we:vitest.config.ts", "we:./__tests__/vitest.real.config.test.mjs", "we:./__tests__/vitest.config.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a small config-wiring test, registered in REPO_SCAN_TESTS because the repo-scan entry already… (from web-everything/web-everything#7112 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:vitest.real.config.ts:18` — Add a small config-wiring test, registered in REPO_SCAN_TESTS because the repo-scan entry already matches on we:vitest.config.ts and we:vitest.real.config.ts. It would assert the PR exclude, the real include, and the `passWithNoTests` derivation.
2. `we:.github/workflows/real-tests.yml:1` — Add a workflow-shape test that parses we:.github/workflows/real-tests.yml and asserts the triggers are exactly schedule and workflow_dispatch, that the permissions are contents:read and issues:write, and that the title prefix in the create/edit and the list filter match.
3. `we:.github/workflows/real-tests.yml:24` — Add a workflow-lint gate in check:standards: every actions/checkout in a workflow that runs repo code must set persist-credentials: false unless it is on an allowlist.
4. `we:vitest.real.config.ts:14` — Add a unit test importing we:vitest.real.config.ts that asserts the env pins and the include glob. A cheaper alternative is a check:standards rule that vitest.*.config.ts files set WE_TEST_HERMETIC.
5. `we:vitest.config.ts:299` — Extend the full-scope guard test to load both vitest configs and assert the exclude entry and the passWithNoTests derivation.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7112@fdc1cd99a6d8be15d69b430b976fa53765e030c7

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
