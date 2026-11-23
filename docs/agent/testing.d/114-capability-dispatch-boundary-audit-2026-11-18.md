## Capability dispatch boundary audit (2026-11-18)

Capability admission belongs to the first write/launch of each repo's dispatch path,
never to constellation roster selection. Capability-off and unknown repos retain evidence
reads, cancellation/dequeue, escalation/hold reconciliation, owed-result flushes, timeout
recovery and release/cleanup. The operator sees a refusal and can enable the capability
or handle the held action manually. No refusal consumes a scope-refresh attempt.

The audited lander (`scripts/merge-ai-prs.mjs`) action inventory is:

- `enqueueWithSameHeadGuard`: same-head branch refresh/update, CI restart, enqueue.
- `announceAndRetargetBeforeLand`: green-event coverage publication and stacked-PR retarget;
  the enqueue itself independently admits through the helper above.
- `runRenamedPrRefresh`: renamed-card/evidence-conflict branch refresh and resulting CI.
- `healNnnCollision`: collision repair push and resulting CI (dry-run probe stays read-only).
- `rebaseDropManifest`, then `rebaseDropContent`: manifest/content rebuild pushes, collision
  renumbering, resulting CI and acceptance restamps; one admission before either rebuild.
- `refreshApprovedHead`: shared admission before `refreshApprovedHeadChecked`, covering
  `mergeQueueGate`'s carrier/sibling prechecks and candidate freshness, required-workflow
  recovery and stale-merge recovery. Refresh can push or rerun CI; a refusal returns a
  failed refresh and cannot restamp acceptance.
- `sweepQueuedHashCards`: dequeue stays available; injected `prepare` admits before
  branch numbering/rewrite/push.
- `runCardGroupPass`: group reconciliation stays available; injected `form` admits before
  a combined branch push, PR creation and its result publication.
- Candidate cascade: admission after successful fresh revalidation, before freshness
  recovery, land/coverage stamps, retargeting, branch preparation, direct merge/enqueue
  and confirmed-land result/ledger publication. Already-merged cleanup remains available.
- Local post-land writers: admission before detached `handOffDrainFollowup`; refusal also
  prevents inline branch sync, hash repair, numbering/resolve push and derived-artifact
  push. Stranded-sweep discovery remains available in dry-run mode; its apply/push is held.
  Queue evidence probes and follow-up bookkeeping remain readable.

The audited review daemon (`skills-src/conveyor/review-daemon.mjs`) action inventory is:

- Scope-bloat recovery: admission before refresh/push, attempt recording and marker publication.
- Recovery red-team callback: admission before result-label sync, gate catch-up CI rerun,
  queued/unqueued review-job launches and their publication.
- Ordinary review: admission before review job/session launch and round/result tagging.
- Convert-advisory: admission before the targeted judge and note/label publication,
  including dry-run judging and already-converted label repair.
- Prep-review: admission before the review stage; refusal runs its existing `off` mode,
  preserving stale-label/owned-hold cleanup while suppressing judges and review publication.

Other branch-touched dispatchers audited: `reconcile-fix-dispatch.mjs` admits before MQ
failure refresh/push/rerun, idle restack, fresh/resumed/routed fixer launches and notices;
`review-dispatch.mjs` plans/admit before wrapped or background reviewer launch;
`ci-heal-pr-dispatch.mjs` admits before healer launch/publication while timeout reruns and
flushes stay available; `promote-draft-pr-dispatch.mjs` admits before ready/promotion;
`orphan-fix-round.mjs` admits redispatch while rearm/escalation stays available;
`load-flake-reverify.mjs` admits redispatch before merge-main/push and redispatch publication,
and saved-fix push before pushed-result/rearm publication. Obsolete/exhausted holds still end.

Regressions live in `merge-ai-prs-capability.test.mjs`, `review-daemon.test.mjs`,
`prep-review.test.mjs` and the dispatchers' existing capability suites. The structural
`capability-dispatch-only.test.mjs` pins admitted boundaries and rejects roster filtering.
Run affected files through heavy-admission; test effects are injected, never live forge writes.
Dispatching fixtures, including soak scenarios, must use registered repo identities with
the required capability. An injected dispatch callback still passes through capability
admission; keep unknown identities for tests that assert refusal.

