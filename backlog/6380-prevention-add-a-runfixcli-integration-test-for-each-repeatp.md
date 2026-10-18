---
bornAs: xd1ks2w
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/fix-run.mjs", "we:scripts/lib/numbering-carry.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/lib/human-clearance-carry.mjs", "we:scripts/operations/__tests__/fix-run.test.mjs", "we:scripts/lib/__tests__/numbering-carry.test.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs", "we:scripts/lib/__tests__/human-clearance-carry.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — Add a runFixCli integration test for each repeatPlan action (stand-down and reset). The longer-te… (from web-everything/web-everything#5463 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/fix-run.mjs:586` — Add a runFixCli integration test for each repeatPlan action (stand-down and reset). The longer-term guard is a check:standards rule that flags a new exported-branch keyword (a reason string such as 'repeated-finding') that appears in no test file.
2. `we:scripts/lib/numbering-carry.mjs:660` — Return retryable: false from proveIdenticalNetPatch for deterministic failures (lossy decoding, empty patch, oversized output) and keep it only for exec/timeout errors. Add a unit test per failure class.
3. `we:scripts/merge-ai-prs.mjs:729` — Add a test that builds createTamperParkCarryCallback over a diffExec-shaped wrapper (`{cwd, ...opts}`) with real git and asserts a net-patch carry. Alternatively make the wrapper ignore undefined cwd.
4. `we:scripts/lib/human-clearance-carry.mjs:233` — Add a test asserting the intended interaction of `equivalence: 'strict'` with an offset-only rebase, so the choice is pinned either way.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5463@9e3d7874fcb9338ae5830ee7f121e6f9abb266e6

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
