---
kind: story
size: 5
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/session-reaper.mjs", "we:skills-src/conveyor/review-daemon.mjs", "we:scripts/operations/review-dispatch.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs", "we:scripts/conveyor/__tests__/session-reaper.test.mjs", "we:skills-src/conveyor/__tests__/review-daemon.test.mjs", "we:scripts/operations/__tests__/review-dispatch.test.mjs"]
dateOpened: "2026-09-25"
tags: []
---

# Review loops let a PR stick: infra cool-off bypassed by session-reaper, zero-finding reviews escape the round cap, same head reviewed twice

Three review-loop bugs let a PR stick or double-fire (#3383/#4075 Phase 1). (a) we:scripts/conveyor/session-reaper.mjs's completion-record reap axis ignores we:scripts/conveyor/reconcile-core.mjs's own INFRA_RETRY_COOLOFF_MS, so a blocked-on-infra session is stopped ~2 min after completion instead of after the intended 15-minute cool-off, and the PR is re-dispatched early. (b) we:scripts/conveyor/reconcile-core.mjs's zero-findings review-dispatch branch (~line 774) hands back a hardcoded attempts:0 every tick, so a review that crashes / reports blocked-on-infra / parks without a comment re-dispatches forever, never hitting any cap. (c)/(d) nothing compares the PR's current head SHA against what was last/currently reviewed: confirmed live on chalbert/web-everything#2588 (changes requested 23:55Z, accepted 00:00Z 2026-09-24, three review sessions ~2 min apart on one unchanged head) — we:skills-src/conveyor/review-daemon.mjs's own documented claude-agents listing-lag race. Fix: honor the infra cool-off in we:scripts/conveyor/session-reaper.mjs; give the zero-findings branch in we:scripts/conveyor/reconcile-core.mjs a real PR-comment-derived durable attempt count; add a durable review-dispatched-for-head marker (posted from we:scripts/operations/review-dispatch.mjs) plus a grace-window + per-head cap guard in we:scripts/conveyor/reconcile-core.mjs so at most one review is in flight per unchanged head.

## Done when

1. **Executable** — `npx vitest run we:scripts/conveyor/__tests__/reconcile-core.test.mjs we:scripts/conveyor/__tests__/session-reaper.test.mjs` is red before this item's fixes and green after, covering: (a) we:scripts/conveyor/session-reaper.mjs's completion-record reap axis honors we:scripts/conveyor/reconcile-core.mjs's own `INFRA_RETRY_COOLOFF_MS` before reaping a blocked-on-infra session; (b) the zero-findings review-dispatch branch in we:scripts/conveyor/reconcile-core.mjs derives `attempts` from a real, PR-comment-derived durable count instead of a hardcoded `0`, and refuses once a per-head cap is hit; (c)/(d) we:scripts/conveyor/reconcile-core.mjs refuses a second review dispatch against an unchanged head within a grace window.
2. **Live proof** — a real, read-only `runReconcilePass({repo:'chalbert/web-everything'})` run before and after the fix, plus a replay of `chalbert/web-everything#2588`'s real comment history showing its second/third review would now be refused rather than dispatched.
