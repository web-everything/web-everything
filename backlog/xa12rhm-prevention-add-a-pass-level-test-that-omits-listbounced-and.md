---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/orphan-fix-round.mjs", "we:scripts/conveyor/__tests__/orphan-fix-round.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Add a pass-level test that omits listBounced and injects exec into the default lister, for exampl… (from web-everything/web-everything#7429 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/orphan-fix-round.mjs:280` — Add a pass-level test that omits `listBounced` and injects `exec` into the default lister, for example through a `vi.mock` of `execFileSync`. A review lens 'every new default-arg wiring has one test through the default path' is a weaker fallback.
2. `we:scripts/conveyor/orphan-fix-round.mjs:206` — Fetch one more page, or check a `Link: rel=next` header, to tell 'exactly at cap' from 'over cap'. Add a boundary test with exactly 500 PRs and an empty 6th page. For repos over the cap, add a daemon-level alert on repeated cap errors.
3. `we:scripts/conveyor/__tests__/orphan-fix-round.test.mjs:109` — A PR-description lint that checks the test names cited in Acceptance against names in the diff. Otherwise, regenerate the description from the final diff.
4. `we:scripts/conveyor/orphan-fix-round.mjs:187` — Review lens: the PR description's behavioural claims must match the tests that pin them. A deterministic gate is not practical for prose.
5. `we:scripts/conveyor/orphan-fix-round.mjs:207` — Add a deterministic multi-pass regression test with at least 500 open PRs that asserts eventual orphan processing while preserving the prohibition on dispatch from uncertified partial listings.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7429@d53d955003158a9b63a282494ebbb06b85f3c865

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
