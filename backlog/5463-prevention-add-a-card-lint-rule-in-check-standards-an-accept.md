---
bornAs: x361dom
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/5453-event-log-accepts-runtime-events-action-requested-and-worker.md", "we:backlog/4283-drain-daemon-consumes-the-pr-events-feed-and-lengthens-its-p.md", "we:backlog/5460-decision-rule-changes-run-in-shadow-new-rules-beside-old-dif.md"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Add a card-lint rule in check:standards: an acceptance item containing 'only'/'authenticated'/'si… (from web-everything/web-everything#4500 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/5453-event-log-accepts-runtime-events-action-requested-and-worker.md:28` — Add a card-lint rule in check:standards: an acceptance item containing 'only'/'authenticated'/'signed'/'refuses' must name a test case or be marked [Executable]. Also reject any card with a security claim and no negative-path test.
2. `we:backlog/4283-drain-daemon-consumes-the-pr-events-feed-and-lengthens-its-p.md:18` — Add a check:standards rule: when a card cites a platform-decisions statute anchor, it must have an acceptance item tagged with that anchor and naming a test. The rule should fail on a TODO placeholder 'Done when' in any card that is edited.
3. `we:backlog/5453-event-log-accepts-runtime-events-action-requested-and-worker.md:25` — Plan named tests in we:scripts/conveyor/pr-events-worker/__tests__/core.test.mjs: rejectsUnauthenticatedRuntimeAppend and rejectsRuntimeEventsThroughWebhook, asserting rejection and no stored event or sequence advancement; run them as deterministic implementation gates.
4. `we:backlog/5460-decision-rule-changes-run-in-shadow-new-rules-beside-old-dif.md:35` — Plan liveRuleFailureNeverDispatchesCandidate in we:scripts/conveyor/__tests__/decider-daemon.test.mjs: make live rules throw and candidate rules return an action, then assert no action-requested event is appended; require it as a deterministic implementation gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4500@b79d012eaab97814d304d5b06a7fb020d1f790f9

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
