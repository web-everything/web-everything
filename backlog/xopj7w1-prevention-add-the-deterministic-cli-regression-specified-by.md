---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/__tests__/daemons-render.test.mjs", "we:scripts/operations/daemons-render-io.mjs", "we:backlog/xbltgqd-prevention-pin-daemon-render-evidence-and-scheduled-advisory.md", "we:scripts/operations/__tests__/daemons-render-io.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Add the deterministic CLI regression specified by existing prevention card xbltgqd A1; it is file… (from web-everything/web-everything#7491 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:scripts/operations/__tests__/daemons-render.test.mjs:299` — Add the deterministic CLI regression specified by existing prevention card xbltgqd A1; it is filed but not yet an executable gate.
2. `we:scripts/operations/daemons-render-io.mjs:70` — Implement the controlled filesystem regression tests already filed in prevention card xbltgqd A2.
3. `we:backlog/xbltgqd-prevention-pin-daemon-render-evidence-and-scheduled-advisory.md:19` — Give the already-filed A4 operational check a stable name and require its recorded assertions before marking that operational acceptance complete.
4. `we:backlog/xbltgqd-prevention-pin-daemon-render-evidence-and-scheduled-advisory.md:16` — The follow-up work is already filed here; require acceptance entries to reference named automated tests or named operational checks, and deterministically validate automated references.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 4 → #5473, finding 6 → #5473, finding 7 → #5473.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7491@6056df24164d0c3791afcfc915ca86e884486269

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
