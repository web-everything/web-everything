---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/xyn4tt0-required-checks-reader-an-access-denial-must-never-drop-a-ch.md"]
dateOpened: "2026-10-12"
tags: []
---

# Prevention — Add a card-lint or filing-time check that any file:line cited in a card resolves (the line exists… (from web-everything/web-everything#5004 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/xyn4tt0-required-checks-reader-an-access-denial-must-never-drop-a-ch.md:13` — Add a card-lint or filing-time check that any `file:line` cited in a card resolves (the line exists in the current file), and that A1 is filled before status moves from open to in-progress.
2. `we:backlog/xyn4tt0-required-checks-reader-an-access-denial-must-never-drop-a-ch.md:16` — Require behavioral backlog cards to supply repository-qualified planned test files, named cases, and observable assertions before implementation. Proposed cases in we:scripts/lib/__tests__/required-status-checks.test.mjs should assert that denial preserves a live-only check absent from declared defaults, unions partial observations with the last live set, and refuses when neither source exists. A deterministic backlog gate should reject an executable acceptance entry that remains TODO.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5004@be2e590cd454625556752db062e5f33b3c0c047d

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
