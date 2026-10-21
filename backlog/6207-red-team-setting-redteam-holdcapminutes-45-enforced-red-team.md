---
bornAs: xfrggva
kind: story
size: 5
status: open
scope: ["we:scripts/lib/drain-merge-strategy.mjs", "we:scripts/lib/drain-queue-safety.mjs", "we:scripts/settings/drain-queue-safety.json", "we:scripts/lib/__tests__/drain-merge-strategy.test.mjs", "we:scripts/lib/__tests__/drain-queue-safety.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Red team setting redTeam.holdCapMinutes=45 enforced: red-team-pending past the cap goes to needs-you

Enforce the operator-approved redTeam.holdCapMinutes default of 45: at the deadline publish the held PR to the existing needs-you feed with elapsed wait, while keeping merge admission closed. The existing redTeamPendingMaxMin threshold only reports a health smell and may request missing work. Reuse that timer; do not introduce competing deadlines. Historical #5482/#5480 references are not matching local prerequisite cards.

## Acceptance

- [A1] `q=we:scripts/readiness/heavy-admission.mjs; t=we:scripts/lib/__tests__/drain-merge-strategy.test.mjs; node "${q#we:}" run -- npx vitest run "${t#we:}"` — add clock-driven cases at 44:59, 45:00 and 45:01: no early attention, attention at/after the cap with repo/PR/head and waited minutes, and no enqueue. Cover running, queued and missing-result holds; current health-smell-only behavior must fail.
- [A2] `q=we:scripts/readiness/heavy-admission.mjs; t=we:scripts/lib/__tests__/drain-queue-safety.test.mjs; node "${q#we:}" run -- npx vitest run "${t#we:}"` — cover holdCapMinutes default 45 and env/tool/platform precedence with source logging; preserve legacy redTeamPendingMaxMin as fallback when the canonical value is absent, rejecting nonpositive/nonfinite values.
- [A3] `q=we:scripts/readiness/heavy-admission.mjs; t=we:scripts/lib/__tests__/drain-merge-strategy.test.mjs; node "${q#we:}" run -- npx vitest run "${t#we:}"` — publish through the real feed writer into a temporary directory: repeated passes/restarts produce one open attention event per repo/PR/head; a new head starts a new timer. A failed feed write leaves the hold intact and retries publication.

## Non-goals

- [N1] No timed merge bypass, no change to confirmed-break dispositions or scheduling policy; no HTTP endpoint, so body/rate/CSRF controls are inapplicable.

## Edge cases this change must handle

1. **Untrusted text** — Publish bounded, scrubbed reasons through the feed sanitizer; never interpolate PR text into executable commands.
2. **Truncated reads** — Unreadable pending/feed state cannot release a hold or fabricate a successful notification.
3. **Shared state files** — Use publishAttention and its lock/atomic state handling; do not append an independent feed format.
4. **Fail closed** — Notification failure never enables enqueue; the cap is escalation only, including source/docs/config/data changes.
5. **Identity scoping** — Key timer and attention by repo, PR and exact head.
6. **State over time** — Preserve firstPendingAt across restart; reset only on a head change or a genuinely cleared hold, not each poll.
7. **Who wrote it** — Keep setting-source logging and drain-produced attention distinct from an operator acknowledgment.

## Grounding

`we:scripts/lib/drain-merge-strategy.mjs:248` computes the threshold; `we:scripts/lib/drain-merge-strategy.mjs:382` branches after the smell. `we:scripts/lib/drain-queue-safety.mjs:15` defaults the old key to 45. `we:scripts/operations/needs-you-feed.mjs:204` provides locked, deduplicated publication.
