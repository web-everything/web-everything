---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/codex-audit.mjs", "we:scripts/operations/__tests__/audit-verdict.test.mjs", "we:scripts/operations/__tests__/codex-audit.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a test where the tip moves inside deps.diffFiles or deps.readRecords and assert runCodex is n… (from web-everything/web-everything#7334 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/codex-audit.mjs:225` — Add a test where the tip moves inside `deps.diffFiles` or `deps.readRecords` and assert `runCodex` is not called. A mutation-testing pass over guard lines would find this class of gap.
2. `we:scripts/operations/codex-audit.mjs:148` — Add a cascade test that an invalid env var never moves the result away from the configured value for either key.
3. `we:scripts/operations/codex-audit.mjs:164` — Add a test that `--json` plus a superseded branch yields parseable output, or a documented exit-4 contract for callers.
4. `we:scripts/operations/__tests__/audit-verdict.test.mjs:1357` — Reword the comment to say only the imports are pinned. Or add a behavioural test that the delta veto refuses protected paths, which this PR already has in the merge-path test.
5. `we:scripts/operations/__tests__/codex-audit.test.mjs:780` — A table-driven test over (configured, env) pairs for each override. This is a lint-level review item, not a gate.
6. `we:scripts/operations/codex-audit.mjs:224` — Add the named deterministic test, change the mocked branch tip inside diffFiles, and assert exit 4, zero runCodex calls, and zero records; include it in the existing test gate.
7. `we:scripts/operations/__tests__/codex-audit.test.mjs` — Add a deterministic concurrency regression test that exercises multiple callers for the same branch and head.
8. `we:scripts/operations/codex-audit.mjs:111` — Extend the deterministic settings test matrix to malformed raw leaves in both layers with a nondefault inherited value, and validate raw debounce leaves before accepting cascade results.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7334@5768606da2a4e9c11b729e40f18a435858b2b6bd

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
