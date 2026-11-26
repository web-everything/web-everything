---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/verify-lane-gate.mjs", "we:scripts/lib/__tests__/verify-lane-gate.test.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Prevention — Write a test per hardening flag that uses the exact hostile fixture (a symlink to a valid file, a… (from web-everything/web-everything#7547 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/verify-lane-gate.mjs:1099` — Write a test per hardening flag that uses the exact hostile fixture (a symlink to a valid file, a FIFO, a symlink escaping the checkout, a directory over the entry limit). Prefer a mutation-check gate that flags a security-relevant line with no reddening test.
2. `we:scripts/lib/verify-lane-gate.mjs:1112` — Give the target-file existence check its own try/catch with a distinct reason such as 'prep-test-missing', and add a test for it.
3. `we:scripts/lib/__tests__/verify-lane-gate.test.mjs:1030` — Add a unit case with a symlink to a valid prep file (and a FIFO case) that asserts no argv is suggested. A lint that requires each security-guard flag (O_NOFOLLOW, O_NONBLOCK) to have a mutation-checked test would catch the class.
4. `we:scripts/lib/verify-lane-gate.mjs:1105` — Add tests for each branch: 2049 directory entries, oversized stdout, a symlinked test target escaping the repo, and a prep whose Scope omits the repo key. A coverage-on-branch gate for we:scripts/lib/verify-lane-gate.mjs would flag untested guard branches.
5. `we:scripts/lib/verify-lane-gate.mjs:1086` — Add a deterministic test gate using a resolvable symlink and a FIFO subprocess with a bounded timeout; require removal of the corresponding open flags to fail those named tests.
6. `we:scripts/lib/__tests__/verify-lane-gate.test.mjs` — Add a named regression test using a live symlink to otherwise valid prep evidence; assert prep-unreadable and no suggested argv, and require removing O_NOFOLLOW to redden that test.
7. `we:scripts/lib/verify-lane-gate.mjs` — Add a subprocess regression test with a matching FIFO and no writer, asserting completion within a timeout, prep-unreadable, and no suggested argv; require removal of O_NONBLOCK to fail it.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7547@c099d3942656c3649a72a305061b64ae89568ad0

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
