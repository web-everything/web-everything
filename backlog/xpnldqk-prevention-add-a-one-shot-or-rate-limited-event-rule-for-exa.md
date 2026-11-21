---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/fix-dispatch-claim.mjs", "we:scripts/conveyor/__tests__/fix-dispatch-claim-stale-release.test.mjs", "we:scripts/conveyor/__tests__/pr-live-owner-watch.test.mjs", "we:scripts/conveyor/__tests__/fix-dispatch-claim.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a one-shot or rate-limited event rule, for example keyed on claim and owner with a per-claim… (from web-everything/web-everything#7271 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/fix-dispatch-claim.mjs:594` — Add a one-shot or rate-limited event rule, for example keyed on claim and owner with a per-claim `lastQuarantineEventAt` in meta, plus a test asserting a healthy live claim emits no event on consecutive sweeps. Cheapest durable form: an event-volume assertion in the soak break.
2. `we:scripts/conveyor/__tests__/fix-dispatch-claim-stale-release.test.mjs:14` — Parameterize the claim fixtures over every claim kind that the code names (`fix`, `ci-heal`, and `fixing` as the exclusion). A lint that flags kind-named prose in a PR with no test mentioning that kind is possible but heavier.
3. `we:scripts/conveyor/__tests__/pr-live-owner-watch.test.mjs:9` — A scope check that compares changed files against the card's declared Files list would flag this. The PR's Files list omits these two files.
4. `we:scripts/conveyor/fix-dispatch-claim.mjs:405` — Make `listFreshClaimAgents` track per-source row counts or readability. Mark `incomplete` when the claude source returns `[]` while a claim is being judged absent. Add a test with an empty claude listing plus non-empty wrapped rows that expects no release. A unit test for this exact shape is the cheapest guard.
5. `we:scripts/conveyor/__tests__/fix-dispatch-claim-stale-release.test.mjs:1` — Run the 'session-gone' release test over `it.each(['fix', 'ci-heal'])`. For the longer term, add a lint or check that a claim-kind enumeration in prose has a parameterized test over the kind set.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7271@54982b665fea34f3e28394d654194f3ef9d17bd1

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
