---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:docs/agent/platform-decisions.md"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Make PR 2's shared conformance case (we:verdict-ledger-store-conformance.mjs) assert the retry-af… (from web-everything/web-everything#7310 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:docs/agent/platform-decisions.md:6216` — Make PR 2's shared conformance case (`we:verdict-ledger-store-conformance.mjs`) assert the retry-after-success path with a stale `expectPrSeq` returns the duplicate result. Add one sentence to the statute stating 'the duplicate check precedes the prSeq compare, and the result is `{ok:true, appended:0, duplicates:n}`'.
2. `we:docs/agent/platform-decisions.md:6216` — Land the validator and conformance enforcement in the same PR as the statute, or add 'enforced from PR 2 (card #xctsi6q)' to the sentence. A `check:statute` rule that links each normative 'required' bullet to a test name would catch the class.
3. `we:docs/agent/platform-decisions.md:6216` — Add a conformance-suite case, planned for PR 2, where the same event id is retried with the stale expectPrSeq and must return duplicate. Also add a statute-lint rule that each contract bullet naming two outcomes states which takes precedence. File the rule as a backlog item.
4. `we:docs/agent/platform-decisions.md:6222` — Add a PR 2 checklist rule that every 'required', 'absent' or 'refuses' clause in a statute contract maps to a named test. Add a validateLedgerStore test for both directions of the appendIf-versus-ordering rule. File this as a backlog item.
5. `we:docs/agent/platform-decisions.md:6216` — Add a deterministic preparation check requiring each acceptance guarantee to map to a repository-qualified test file, named case, and observable assertion; permit explicitly planned cases for statute-only changes.
6. `we:docs/agent/platform-decisions.md:6216` — Add a deterministic preparation gate requiring each new contract guarantee to identify a repository-qualified test file, named case, and observable assertion; allow planned cases for statute-only preparation.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7310@8da3baf26b05c05539d4e98f01973854e24c913b

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
