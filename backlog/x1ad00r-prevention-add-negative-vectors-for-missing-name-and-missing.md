---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/file-class-policy.mjs", "we:scripts/lib/__tests__/file-class-policy.test.mjs", "we:scripts/lib/protected-path-floor.mjs", "we:scripts/lib/__tests__/protected-path-floor.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Add negative vectors for missing name and missing order. Make evaluate emit a fail-closed row-mis… (from web-everything/web-everything#7426 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/file-class-policy.mjs` — Add negative vectors for missing `name` and missing `order`. Make `evaluate` emit a fail-closed `row-misconfigured` kind when a class's required params are absent. Fold this into the refusal-mode hardening card (dlv:FILE-CLASS-REFUSE) before any verdict is consumed.
2. `we:scripts/lib/__tests__/file-class-policy.test.mjs` — Add three tests to we:scripts/lib/__tests__/file-class-policy.test.mjs: a second `recordOnly` to the same path throws EEXIST, a duplicate-path diff throws, and a change with no identity throws. Add an engine-import allowlist test (only node:crypto and node:fs). The lowest-cost gate is a mutation-check lane that deletes each guard and expects a red test.
3. `we:scripts/lib/__tests__/file-class-policy.test.mjs` — Extend the walk to the whole repo (excluding node_modules and tests). Assert full `findings` equality in the replay, including `source`. Alternatively, reword the PR claim to match the guard's actual scope.
4. `we:scripts/lib/file-class-policy.mjs:78` — Make pin mismatch throw in `classTable`/`candidates`. Add a negative vector or test named something like 'mismatched preset/parent digest refuses'. File it as a must-fix card gating dlv:FILE-CLASS-REFUSE.
5. `we:scripts/lib/file-class-policy.mjs:187` — Add a test such as 'recordOnly refuses to overwrite an existing output (EEXIST)' to we:scripts/lib/__tests__/file-class-policy.test.mjs. A lint rule that cross-checks LOCK_HOLDERS entries against actual `wx` use would also catch this class.
6. `we:scripts/lib/__tests__/file-class-policy.test.mjs:96` — Widen the walk to the repo roots that hold executable code and flag any non-literal specifier in files that mention the engine's basename. Alternatively add a check:standards rule on the engine path.
7. `we:scripts/lib/protected-path-floor.mjs:162` — Add a deterministic existing-output preservation test to the writer suite; this guard still needs to be filed.
8. `we:scripts/lib/file-class-policy.mjs:175` — Add a deterministic module-boundary gate prohibiting subprocess, network, and credential APIs, plus assertions restricting filesystem calls to the requested input/output; this guard still needs to be filed.
9. `we:scripts/lib/file-class-policy.mjs:98` — Add a deterministic parameterized test requiring an explicit 'pass' outcome, covering omitted, null, and unsupported outcomes in both build-check paths.
10. `we:scripts/lib/__tests__/file-class-policy.test.mjs:44` — Add a deterministic test that precreates the output, asserts EEXIST from recordOnly, and asserts that the original bytes remain unchanged.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7426@6c64738a711cdd0b6a5c15a0cb2dce47587ecf76

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
