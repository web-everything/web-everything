---
bornAs: xllkd2p
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/6247-we-ci-artifact-uploads-never-fail-a-merge-group-run.md"]
dateOpened: "2026-10-18"
tags: []
---

# Prevention — Add a card-template lens or checklist item: when a card changes a producer step, name the consume… (from web-everything/web-everything#5552 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:backlog/6247-we-ci-artifact-uploads-never-fail-a-merge-group-run.md:14` — Add a card-template lens or checklist item: when a card changes a producer step, name the consumer steps and state their behaviour on a missing input. A deterministic gate is not practical for this class.
2. `we:backlog/6247-we-ci-artifact-uploads-never-fail-a-merge-group-run.md:17` — Add a deterministic workflow check that rejects retry-only upload handling unless exhausted retries are explicitly nonfatal.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 2 → #6023, finding 3 → #5360, finding 5 → #5360.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5552@d42b624fb216d196b21e8dff9c931dd6e00107da

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
