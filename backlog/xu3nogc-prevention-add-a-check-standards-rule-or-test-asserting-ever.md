---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/run.mjs", "we:scripts/conveyor/health-investigate-dispatch.mjs", "we:scripts/operations/judge-sweep-facts.mjs", "we:scripts/operations/__tests__/run.test.mjs", "we:scripts/conveyor/__tests__/health-investigate-dispatch.test.mjs", "we:scripts/operations/__tests__/judge-sweep-facts.test.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Prevention — Add a check:standards rule or test asserting every op that isReadOnlyOperation appears in the mem… (from web-everything/web-everything#5857 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/run.mjs:758` — Add a check:standards rule or test asserting every op that isReadOnlyOperation appears in the memory-store and zeroWrites lists. Better, derive both lists from the declaration instead of hand-maintained arrays.
2. `we:scripts/conveyor/health-investigate-dispatch.mjs:71` — Doc note only: PR descriptions should name the exported list they touched.
3. `we:scripts/operations/judge-sweep-facts.mjs:64` — Add a shared terminal-safe JSON serializer in scripts/lib, with a test that iterates the full Bidi_Control and C1 sets, and use it from every CLI printer.
4. `we:scripts/operations/judge-sweep-facts.mjs:55` — Add a check:standards rule that operations using operatorGh must validate repo against repoKeyForSlug (the constellation allowlist), with a test that an unknown slug is refused.
5. `we:scripts/operations/run.mjs:758` — Add a deterministic test named 'judge-sweep-facts CLI never creates persistent stores' that exercises actual CLI store selection and fails if either persistent-store factory is invoked.
6. `we:scripts/operations/run.mjs:758` — Add a deterministic CLI integration test that uses production store selection and fails on persistent writes, covering both default output and --json.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5857@e4619f996c426a750342de3964f33fbf3042d02d

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
