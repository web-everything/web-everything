---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/guard-bash.mjs", "we:scripts/__tests__/guard-bash.test.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Prevention — Add a differential 'common reads stay allowed' table (unquoted ?per_page=, .[0] jq filters, {owne… (from web-everything/web-everything#7586 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/guard-bash.mjs:4560` — Add a differential 'common reads stay allowed' table (unquoted `?per_page=`, `.[0]` jq filters, `{owner}`) for gh api to we:guard-bash.test.mjs, so any widening of argvWordShape reddens it. Also restrict the hidden(k) bail-out to cases that could change the endpoint or method.
2. `we:scripts/guard-bash.mjs:4630` — Add a differential table test of non-canonical endpoint spellings (case, `//`, `./`) that is checked against the live GitHub routing rules. If one routes, normalise it in the guard.
3. `we:scripts/guard-bash.mjs` — Add a deterministic parameterized regression test covering separated, attached, and equals-delimited short-option values for REST methods and GraphQL fields; this guard remains to be filed.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7586@c045bba8f08da6cad6d67155445845589817b6f7

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
