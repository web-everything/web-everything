---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/__tests__/daemon-smoke-slots.test.mjs", "we:scripts/lib/daemon-rebuild/rebuild.mjs", "we:scripts/lib/daemon-rebuild/__tests__/rebuild.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Review lens: each pre-mortem bullet in a card must map to a named test. A card-lint that flags 't… (from web-everything/web-everything#7428 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/__tests__/daemon-smoke-slots.test.mjs:50` — Review lens: each pre-mortem bullet in a card must map to a named test. A card-lint that flags 'test with …' phrases lacking a matching test title would make this deterministic.
2. `we:scripts/lib/daemon-rebuild/rebuild.mjs:474` — Review lens: any log line cited in an Acceptance item needs an expect(log.error).toHaveBeenCalledWith(...) in the same PR.
3. `we:scripts/lib/__tests__/daemon-smoke-slots.test.mjs:78` — When a pre-mortem lists a test, require a named test per item in the PR template, and have a review lens cross-check each pre-mortem bullet against a test name.
4. `we:scripts/lib/daemon-rebuild/rebuild.mjs:475` — A review lens should flag any Acceptance item that names an observable output, such as a log line, without a matching assertion. A deterministic gate is hard here, so the cheapest guard is a PR template checklist that maps each Acceptance item to a test name.
5. `we:scripts/lib/daemon-rebuild/rebuild.mjs:475` — Add the named test to the automated suite, asserting the measured wait and priority decision for each attempt; this guard requires filing and was not filed from this read-only review.
6. `we:scripts/lib/__tests__/daemon-smoke-slots.test.mjs` — Add a deterministic test using an injected clock and captured logger to assert per-attempt elapsed wait, including a queue timeout.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7428@f5fc68f0ebc00347d624a7d3f30a4afc9b930e14

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
