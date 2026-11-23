---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:tools/drain-daemon/daemon.mjs", "we:tools/drain-daemon/lib.mjs", "we:tools/drain-daemon/__tests__/daemon.test.mjs", "we:tools/drain-daemon/__tests__/lib.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Extract the loop's pre-launch admission sequence (gap wait, then re-check pause and lease, then begin pas… (from plateauapp/plateau-app#229 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:tools/drain-daemon/daemon.mjs:787` — Extract the loop's pre-launch admission sequence (gap wait, then re-check pause and lease, then begin pass) into an injectable function in we:tools/drain-daemon/lib.mjs with a test. A check:standards rule could flag guarantees in PR prose that cite only we:tools/drain-daemon/daemon.mjs lines.
2. `we:tools/drain-daemon/daemon.mjs:866` — Move the effective healthy-interval choice into a pure function, for example `effectiveHealthyIntervalSec({ snapshot, ack, settings })`, and test it. Alternatively add a lint that flags non-trivial inline conditionals in we:tools/drain-daemon/daemon.mjs.
3. `we:tools/drain-daemon/daemon.mjs:783` — Extract the pass-admission sequence (gap wait, then re-check pause/lease, then beginPass) into an injectable lib function with a test. Alternatively, add a source-level check that every `sleep(` before `beginPass` is followed by a pause/lease re-check.
4. `we:tools/drain-daemon/daemon.mjs:792` — Wrap beginPass in try/catch in the daemon loop: log, then sleep the base delay and `continue`. Add a daemon-wiring test for it.
5. `we:tools/drain-daemon/lib.mjs:1843` — Add a deterministic parameterized test covering omitted options, each missing field, and non-boolean values.
6. `we:tools/drain-daemon/daemon.mjs:789` — Add a deterministic orchestration test that changes pause or lease state during an injected gap wait and asserts zero pass launches.
7. `we:tools/drain-daemon/lib.mjs:1831` — Add a deterministic fake-clock test asserting the sleep requests and credited elapsed time across a backward jump and recovery.
8. `we:tools/drain-daemon/daemon.mjs:869` — Add deterministic daemon orchestration tests with injected wait and sleep functions, asserting requested delays and subsequent pass timing.
9. `we:tools/drain-daemon/daemon.mjs:790` — Add deterministic fake-clock daemon tests asserting zero pass launches after pause or lease loss during the gap, plus parameterized missing-field admission tests; require them in CI.
10. `we:tools/drain-daemon/daemon.mjs:875` — Add deterministic injected-failure tests asserting accumulated sleep duration and next-pass timing, and run them as required CI tests.

Idempotency key (do not edit): approval-prevention-key:plateauapp/plateau-app#229@9ca44fbd387811f0c7e2f013b1c75e8a252f1529

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
