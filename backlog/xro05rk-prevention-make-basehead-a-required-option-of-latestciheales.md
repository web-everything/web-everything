---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/review-status-tag.mjs", "we:scripts/conveyor/ci-heal-escalation-mark.mjs", "we:scripts/conveyor/__tests__/review-status-tag.test.mjs", "we:scripts/conveyor/__tests__/ci-heal-escalation-mark.test.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Prevention — Make baseHead a required option of latestCiHealEscalationForHead, or add a lint/test that every c… (from web-everything/web-everything#4941 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/review-status-tag.mjs:242` — Make baseHead a required option of latestCiHealEscalationForHead, or add a lint/test that every caller passes it explicitly, so a caller that omits it cannot silently skip the staleness rule.
2. `we:scripts/conveyor/ci-heal-escalation-mark.mjs:515` — Add a CLI test for the budget-refused path asserting either that the base note is also recorded owed or that the operator is notified.
3. `we:scripts/conveyor/ci-heal-escalation-mark.mjs:214` — Add a reconcile-core invariant test that every no-operator-note escalation outcome has a re-arm path when base facts are missing. Add a soak break where the base merges and the PR retargets to main.
4. `we:scripts/conveyor/ci-heal-escalation-mark.mjs:516` — When `--base-pr` is supplied, verify `pr view <base-pr>`'s headRefName equals the stacked PR's baseRefName. Truncate or strip control characters from `reason` before forwarding it to another PR.
5. `we:scripts/conveyor/ci-heal-escalation-mark.mjs:525` — Add a deterministic failure-injection test requiring a durable owed base notification after posting fails, and verifying eventual delivery on retry; persist that notification before considering the handoff complete.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4941@70b16ff6225a72135fb0dc8cdd4053e802c4f136

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
