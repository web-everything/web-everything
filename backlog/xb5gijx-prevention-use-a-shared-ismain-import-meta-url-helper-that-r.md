---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/merge-gate-pin-probe.mjs", "we:scripts/conveyor/__tests__/merge-gate-pin-probe.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Use a shared isMain(import.meta.url) helper that realpaths both sides, and add a spawn-based CLI… (from web-everything/web-everything#7433 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/merge-gate-pin-probe.mjs:59` — Use a shared `isMain(import.meta.url)` helper that realpaths both sides, and add a spawn-based CLI smoke test that asserts the exit code and stdout. A lint or standards rule against raw `argv[1]` vs `import.meta.url` comparisons would stop the whole class.
2. `we:scripts/conveyor/merge-gate-pin-probe.mjs:59` — Add a spawn-based test that runs the script with a stubbed `gh` on PATH and asserts exit codes (pinned 0, missing 1, unknown 1). Compare via `realpathSync(process.argv[1])` in the guard. Longer term, a `check:standards` rule could flag `process.argv[1]` vs `import.meta.url` comparisons that skip realpath.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7433@dc2eba3c2e42cdaab8834329b9feced9a84c8769

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
