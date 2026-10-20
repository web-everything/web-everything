---
bornAs: xb2u1m0
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/6186-assistant-session-registry-and-escalation-delivery.md"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — Make the prepare stamp refuse, or at least print a visible warning, when readTaskAgreement report… (from web-everything/web-everything#5498 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/6186-assistant-session-registry-and-escalation-delivery.md:14` — Make the prepare stamp refuse, or at least print a visible warning, when `readTaskAgreement` reports `acceptance-missing` or a TODO placeholder. That is a deterministic gate in the prepare launcher, independent of the policy mode.
2. `we:backlog/6186-assistant-session-registry-and-escalation-delivery.md:96` — Have the prepare gate require that each Must line and each executable-acceptance sentence names a test file and case, for example via a Must-to-test mapping table checked by lint.
3. `we:backlog/6186-assistant-session-registry-and-escalation-delivery.md` — Add planned cases `rejects registration and ack above 8192 bytes before parsing` in we:scripts/operations/__tests__/operator-session-registry-io.test.mjs and `rejects envelopes above 16384 bytes before parsing` in we:scripts/operations/__tests__/escalation-delivery-io.test.mjs; assert exact-limit acceptance, one-byte-over refusal, no parser invocation on overflow, and unchanged durable state. Run these boundary cases as deterministic implementation gates.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5498@b58e63ba852bd4880132bbebc4bfd92209e84fd3

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
