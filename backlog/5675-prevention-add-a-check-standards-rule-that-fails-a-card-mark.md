---
bornAs: x9cg6aw
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/4124-first-adopter-the-drain-s-post-merge-follow-up-becomes-a-dur.md"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Add a check:standards rule that fails a card marked prepared (preparedDate set) when it has no no… (from web-everything/web-everything#4721 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/4124-first-adopter-the-drain-s-post-merge-follow-up-becomes-a-dur.md:22` — Add a check:standards rule that fails a card marked prepared (`preparedDate` set) when it has no non-TODO `## Acceptance`/`## Done when` section.
2. `we:backlog/4124-first-adopter-the-drain-s-post-merge-follow-up-becomes-a-dur.md` — Implement the planned we:scripts/lib/__tests__/drain-followup-wiring.test.mjs case “long step is not killed” with a separate process ticking while one synchronous command remains blocked beyond staleMs, and assert the original handle remains running without a termination action.
3. `we:backlog/4124-first-adopter-the-drain-s-post-merge-follow-up-becomes-a-dur.md` — Add a planned “default settings keep follow-up inline” test in we:scripts/lib/__tests__/drain-followup-wiring.test.mjs using the real loader, no env override, a configured repo pin, and empty or missing settings; assert runInline executes once and enqueue and tick never execute.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4721@356cdbb20ef7c50cb1341b2e8cca4205734b3ebf

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
