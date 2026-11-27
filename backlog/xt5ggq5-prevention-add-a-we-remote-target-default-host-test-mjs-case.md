---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/readiness/heavy-admission.mjs", "we:scripts/readiness/__tests__/remote-target.test.mjs", "we:scripts/readiness/__tests__/heavy-admission.test.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Prevention — Add a we:remote-target-default-host.test.mjs case that passes host:'other-01' with the default li… (from web-everything/web-everything#7555 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/readiness/heavy-admission.mjs:1371` — Add a we:remote-target-default-host.test.mjs case that passes `host:'other-01'` with the default list and asserts remoteExec receives host 'other-01'. A cheap durable fix: a prep-template lint that requires every 'still honoured' or preserved-behaviour clause in Design ruling to cite a test ID.
2. `we:scripts/readiness/__tests__/remote-target.test.mjs` — Add a deterministic assertion that peekRemoteBreaker is never called for local routing decisions or confinement denial, alongside the existing probe and telemetry assertions.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7555@1919b651cf61032cd09c9d7d35e2f925c47f6a49

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
