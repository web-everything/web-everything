---
bornAs: x8bghhi
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/check-standards.mjs", "we:scripts/__tests__/lane-drain-numbering.test.mjs", "we:scripts/__tests__/check-standards.test.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Prevention — Extract one shared 'would this citation hold numbering' predicate, taking swept paths and the soa… (from web-everything/web-everything#3960 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/check-standards.mjs:1776` — Extract one shared 'would this citation hold numbering' predicate, taking swept paths and the soak partial-sweep rule, into we:citation-check.mjs. Have both the drain and gate 6f-ii-c call it, and add a gate-level test fixture covering a swept-file citation.
2. `we:scripts/check-standards.mjs:1776` — Move the severity decision into a pure function, e.g. `hashPathCiteSeverity({cited, exists, swept})`, and test it. Or add a check-standards fixture-repo test for the gate.
3. `we:scripts/__tests__/lane-drain-numbering.test.mjs:184` — In those tests, `delete process.env[...]` explicitly when the param is undefined, and restore it in finally. A lint rule for stubEnv with an undefined argument would catch the class.
4. `we:scripts/check-standards.mjs:1776` — Add a check-standards fixture test, or extract the gate loop into a testable function in we:citation-check.mjs that returns the error/warn classification per hit.
5. `we:scripts/check-standards.mjs:1777` — Add a deterministic gate integration test that checks failure for an existing exact path under default settings and warning-only behavior for a nonexistent same-hash path.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3960@2067edca8f1798b5d91a65627abea2769c30366d

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
