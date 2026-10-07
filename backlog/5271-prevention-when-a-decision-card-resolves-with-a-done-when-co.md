---
bornAs: xqjydu9
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:docs/agent/platform-decisions.md"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — When a decision card resolves with a "Done when" containing implementation or test obligations, a… (from web-everything/web-everything#4260 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:docs/agent/platform-decisions.md:6153` — When a decision card resolves with a "Done when" containing implementation or test obligations, add a check that each obligation is either met or reassigned to a named open card. The cheaper alternative is to file the build slice (append-site posture plus miss test) and reference it from the statute instead of #3255. A check:standards rule on resolved decision cards could enforce this.
2. `we:docs/agent/platform-decisions.md:6146` — Add a check:standards rule that a statute section with fail-closed or "never" claims must link a test-path or backlog id for its enforcing test. Alternatively, reword the sentence to "will be documented and tested by #3255".
3. `we:docs/agent/platform-decisions.md:6136` — Require every row in a settings table of a safety-adjacent statute to carry an explicit tighter, looser or neutral tag for each non-default value. A lint over the statute table format could check this.
4. `we:docs/agent/platform-decisions.md:6120` — Add a deterministic contract test covering failed holding-event appends against a readable, previously clear ledger under every reviewAuthority value, requiring the merge to defer.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4260@9861488d1838ecae58eb81eb90862bfc21534912

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
