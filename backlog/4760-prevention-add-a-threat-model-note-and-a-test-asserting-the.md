---
bornAs: x9qllbj
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:worker.js", "we:scripts/worker-gate.test.mjs", "we:./__tests__/worker.test.mjs"]
dateOpened: "2026-10-02"
tags: []
---

# Prevention — Add a threat-model note and a test asserting the intended degraded behavior (e.g. an operator-signed bypass… (from chalbert/plateau-app#193 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:worker.js:395` — Add a threat-model note and a test asserting the intended degraded behavior (e.g. an operator-signed bypass or an alerting hook when the global cap trips); a lint cannot decide this.
2. `we:worker.js:417` — Skip the authority call when the cookie is absent or malformed or its signature is invalid, and return the splash directly. Add a test asserting no authority fetch occurs for cookieless requests. Fail-closed semantics for a broken authority would then apply only to well-formed signed cookies.
3. `we:worker.js:361` — Add a minimum-length check for operator/bearer secrets, or route failed bearer attempts through the same authority budget. A check:standards rule requiring a length floor on any new env bearer secret would catch this class.
4. `we:scripts/worker-gate.test.mjs:194` — A test coverage standard or review lens that requires every specific edge case guaranteed in a code comment (e.g., 'even anonymous checks') to be explicitly demonstrated by a named test.

Idempotency key (do not edit): approval-prevention-key:chalbert/plateau-app#193@46cd843db40261cdc14d52a5e90a1f25d6787887

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
