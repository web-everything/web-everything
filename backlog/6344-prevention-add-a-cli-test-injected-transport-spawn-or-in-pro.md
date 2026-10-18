---
bornAs: x6gw387
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/review-precedents.mjs", "we:scripts/lib/review-precedents.mjs", "we:scripts/__tests__/review-precedents.test.mjs", "we:scripts/lib/__tests__/review-precedents.test.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Prevention — Add a CLI test (injected transport, spawn or in-process main) pinning the exit code 2 on an unrea… (from web-everything/web-everything#5243 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/review-precedents.mjs:96` — Add a CLI test (injected transport, spawn or in-process main) pinning the exit code 2 on an unreadable store and the promote/supersede refusals. A standing check that every scripts/*.mjs entrypoint with an --apply flag has a test importing or spawning it would catch the whole class.
2. `we:scripts/lib/review-precedents.mjs:96` — Add a gate that every juror-influencing store (precedents, rulings) either verifies a signed or out-of-band operator attestation, or is read only from a path writable solely by the operator identity. Track this as the filed operator-only write boundary card, and add a `promote` test that fails if the promoter identity is taken from a CLI flag.
3. `we:scripts/lib/review-precedents.mjs` — Add a deterministic producer-consumer regression test using buildVerdictComment with headSha and ordinary body text, then capture against two later PR heads and assert unchanged source.head and precedent ID.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5243@29dddcfeeed323bd8336c0463012a42ee5b3042a

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
