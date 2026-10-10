---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/conveyor/__tests__/sim/world.mjs", "we:scripts/conveyor/pr-events-worker/core.mjs", "we:scripts/lib/daemon-last-good.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs", "we:scripts/conveyor/pr-events-worker/__tests__/core.test.mjs", "we:scripts/lib/__tests__/daemon-last-good.test.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Prevention — Add a check:standards rule that every assertMainNotStale caller in a dispatcher passes an explici… (from web-everything/web-everything#4686 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1823` — Add a check:standards rule that every assertMainNotStale caller in a dispatcher passes an explicit label. That would flag the remaining default-label caller.
2. `we:scripts/conveyor/__tests__/sim/world.mjs:298` — Add a sim scenario for the fresh-adoption default that asserts the intended trade-off: a dispatch runs on old code and the rebuild happens at the next tick start.
3. `we:scripts/conveyor/pr-events-worker/core.mjs:43` — Require comment.author_association in OWNER/MEMBER/COLLABORATOR or comment.user.type==='Bot' (or an allowlisted bot login) in parseGithubEvent for issue_comment, with a test for an outside commenter. A lint or review-lens rule: any webhook-derived classification must name its trusted-actor predicate.
4. `we:scripts/lib/daemon-last-good.mjs:125` — Scope the fresh-adoption grace to the fix caller (an opt-in param from FIX_STALE_GUARD_OPTS), or add a sim scenario or contract test asserting that review and promote still refuse on-path lag under the default env. A lint rule: tests must not pin a new safety-relaxing env to its off value without a companion default-on test.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4686@645a73e336fcff381b1f150f83815fa080920217

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
