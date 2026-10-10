---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/policy-cascade.mjs", "we:scripts/lib/verify-settings.mjs", "we:scripts/lib/github-auth-policy.mjs", "we:scripts/conveyor/pr-stack.mjs", "we:scripts/backlog.mjs", "we:scripts/conveyor/delivery-priority-shadow.mjs", "we:scripts/lib/__tests__/policy-cascade.test.mjs", "we:scripts/lib/__tests__/verify-settings.test.mjs", "we:scripts/lib/__tests__/github-auth-policy.test.mjs", "we:scripts/conveyor/__tests__/pr-stack.test.mjs", "we:scripts/__tests__/backlog.test.mjs", "we:scripts/conveyor/__tests__/delivery-priority-shadow.test.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Prevention — Add a table-driven case per gate branch (non-test env + non-daemon argv, =0, daemon marker, *-dae… (from web-everything/web-everything#4772 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/policy-cascade.mjs:152` — Add a table-driven case per gate branch (non-test env + non-daemon argv, `=0`, daemon marker, `*-daemon.mjs` argv). A lint that flags prose guarantees without a named test would catch the class.
2. `we:scripts/lib/verify-settings.mjs:120` — Pass the reader's parsed env value, or omit `envValues` where parsing happens downstream. Add a reader-level test that an invalid env does not appear as an `(env)` source.
3. `we:scripts/lib/github-auth-policy.mjs:48` — Add a ROWS entry for `github.personalExceptions` that asserts the intended union or override. Longer term, make the cascade test enumerate every leaf of each policy's standard default.
4. `we:scripts/lib/policy-cascade.mjs:182` — Add ROWS-style tests with an invalid tool value over a valid platform value for each `.layered` reader. Alternatively, have `cascadePolicy` require a `valid` argument or warn when it is omitted.
5. `we:scripts/conveyor/pr-stack.mjs:36` — Prefer the explicit `logCascadeSources(policy, finalValidatedObject, sources)` pattern used in `we:build-queue.mjs` for complex readers, rather than logging unvalidated data inside a merge helper; enforce this via review lens.
6. `we:scripts/backlog.mjs:1133` — A review lens focusing on cache key construction to ensure external file dependencies are always hashed by their content or modification time, not their paths.
7. `we:scripts/conveyor/delivery-priority-shadow.mjs:25` — A coverage gate or review lens requiring that every explicit fallback or fail-closed behavior described in a docstring has a dedicated test case.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4772@8a7f7eb5baa26f397626f348a747b4e5bacd4b7d

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
