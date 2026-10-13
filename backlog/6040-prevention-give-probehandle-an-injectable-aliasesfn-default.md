---
bornAs: x5rzvaz
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-jobs-runtime.mjs", "we:scripts/lib/__tests__/daemon-jobs-runtime.test.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Prevention — Give probeHandle an injectable aliasesFn (default localHostAliases) so a test can drive the no-op… (from web-everything/web-everything#5165 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-jobs-runtime.mjs:116` — Give probeHandle an injectable `aliasesFn` (default `localHostAliases`) so a test can drive the no-options path. Add a mutation-probe checklist item to the review lens: a fix whose bug is in the default path needs a test that runs the default path.
2. `we:scripts/lib/daemon-jobs-runtime.mjs:72` — Add a test that a handle whose host is a different machine's short name stays `foreign`, and note the single-machine job-store assumption in the module header. No deterministic gate fits.
3. `we:scripts/lib/__tests__/daemon-jobs-runtime.test.mjs:77` — Add the named default-path test to the existing automated suite, mocking dependencies at module boundaries so the production cache branch executes.
4. `we:scripts/lib/daemon-jobs-runtime.mjs:73` — Add a deterministic regression gate covering distinct hosts with colliding short names, and require evidence of local identity before admitting derived aliases.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5165@e1fb38ef457119ef3d1232d62f8b97a3d0c8a2b9

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
