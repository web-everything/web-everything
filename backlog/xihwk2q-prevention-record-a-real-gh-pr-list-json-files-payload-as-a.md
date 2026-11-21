---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/build-priority-set-io.mjs", "we:scripts/operations/__tests__/build-priority-set.test.mjs", "we:scripts/operations/__tests__/build-priority-set-io.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Record a real gh pr list --json files payload as a fixture and have reader tests consume it. A fi… (from web-everything/web-everything#7268 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/build-priority-set-io.mjs:54` — Record a real `gh pr list --json files` payload as a fixture and have reader tests consume it. A file-reader card could also require checking against a recorded real payload.
2. `we:scripts/operations/build-priority-set-io.mjs:112` — Add a lint rule or helper that runs every cleanup step regardless of earlier throws (for example a `cleanup([...fns])` utility). Alternatively, nest the `finally` blocks so the lock unlink always runs last.
3. `we:scripts/operations/build-priority-set-io.mjs:107` — Extend the install test to assert `statSync(audit).mode & 0o777 === 0o600` after a fresh install. The fsync ordering of the audit append is already waived (R1085).
4. `(no file cited)` — Add the named live test plan with explicit log and build-count assertions, and require every acceptance item to reference a named implemented or planned test.
5. `we:scripts/operations/__tests__/build-priority-set.test.mjs:26` — Add a deterministic CLI integration test named 'build-priority-set preview creates no persistent files' that observes both runtime and run-store locations.
6. `(no file cited)` — Specify a planned test, 'live priority install exposes four IDs without starting builds', in we:web-everything/web-everything/scripts/operations/__tests__/build-priority-set-live.test.mjs, asserting the exact installed IDs, daemon observation, and zero builds.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7268@199f7d1a760ef36ec73f461f9151297be03d7fa4

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
