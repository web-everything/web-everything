---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/guard-bash.mjs", "we:scripts/__tests__/guard-bash.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Add an ALLOWED fixture list of known-terminating no-op loops (getopts, shift, [ -n ]) to the no-p… (from web-everything/web-everything#4170 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/guard-bash.mjs:2160` — Add an ALLOWED fixture list of known-terminating no-op loops (getopts, shift, `[ -n ]`) to the no-polling test file, so any widening of the spin-loop regex turns a named test red.
2. `we:scripts/guard-bash.mjs:2124` — Add the quoted and escaped `sleep` forms to the test list as either DENIED or explicitly documented as accepted gaps, so the coverage boundary is stated in a test rather than only in prose.
3. `we:scripts/guard-bash.mjs:2086` — Add a table-driven test that crosses every wrapper with bare and absolute-path spellings and with every wait primitive. A bypass is then caught as a missing row.
4. `we:scripts/guard-bash.mjs:2043` — Add an ALLOWED/DENIED 'known gap' table in the test file so each unguarded shape is explicitly pinned. Consider denying `while true|:` loops that run a command with no sleep.
5. `we:scripts/guard-bash.mjs` — Add deterministic allow/deny tests pairing executable wait calls with identical text inside strings and comments, and require them in the guard test gate.
6. `we:scripts/guard-bash.mjs` — Require complete argument recognition and gate it with parameterized tests for arithmetic, variables, and numeric-prefix expressions across supported interpreters.
7. `we:scripts/guard-bash.mjs` — Track execution occurrences separately from overlapping scan views, and gate cumulative accounting with repeated identical and distinct nested-script tests.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4170@ffe1146ff476decbc19420a0bca71d3efbfdb237

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
