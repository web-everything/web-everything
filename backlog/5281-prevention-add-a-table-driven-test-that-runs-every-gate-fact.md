---
bornAs: xms0t1h
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:skills-src/conveyor/build-dispatch-daemon.mjs", "we:scripts/lib/host-sample.mjs", "we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs", "we:scripts/lib/__tests__/host-sample.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Add a table-driven test that runs every gate factory (throttle, borrow gate, ci-heal reserve, cli… (from web-everything/web-everything#4284 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:skills-src/conveyor/build-dispatch-daemon.mjs:583` — Add a table-driven test that runs every gate factory (throttle, borrow gate, ci-heal reserve, `cliHostLoadGate`) with a 10%-idle sample and asserts the per-kind admit/hold result. Better still, route all callers through one shared `gateHost` wrapper so there is a single seam to test.
2. `we:scripts/lib/host-sample.mjs:48` — Add a standards check or lint that flags `os.tmpdir()` paths built from predictable names. Move the cache under the coordination root or a 0700 dir, write with O_EXCL / mode 0600, and validate the sample shape and file uid on read. Add a malformed-cache test.
3. `we:skills-src/conveyor/build-dispatch-daemon.mjs:583` — Add a deterministic daemon integration test with a successful 17% idle sample, asserting that build admits and prepare holds through the production gate wiring.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4284@88c5b73b4e68b8457ee064a3ec18c4217857dd31

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
