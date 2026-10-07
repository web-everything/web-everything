---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/readiness/heavy-admission.mjs", "we:scripts/readiness/heavy-queue-projection.mjs", "we:scripts/readiness/__tests__/heavy-admission.test.mjs", "we:scripts/readiness/__tests__/heavy-queue-projection.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Add a shared redactCommand() helper (strip KEY=value env prefixes and --token/--password/--prompt… (from web-everything/web-everything#4167 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/readiness/heavy-admission.mjs:945` — Add a shared `redactCommand()` helper (strip `KEY=value` env prefixes and `--token/--password/--prompt` values), applied wherever a command is persisted. Enforce it with a check:standards rule that flags writes of raw `command` fields into logs under lockRoot.
2. `we:scripts/readiness/heavy-queue-projection.mjs:214` — Use `Object.create(null)` or `Map` for any accumulator keyed by log-derived strings. A lint rule such as eslint `no-prototype-builtins`, or a custom rule against `obj[dynamicKey] ||=` on `{}` literals, would catch this class.
3. `we:scripts/readiness/heavy-queue-projection.mjs:213` — Use a Map or null-prototype dictionary and add a deterministic regression test aggregating constructor, toString, and __proto__ keys.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4167@33dea158315cf635df9e2f3eb8541426112ff61c

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
