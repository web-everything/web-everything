---
bornAs: xw9p4sd
kind: task
status: open
dateOpened: '2026-10-12'
tags: [automation, testing]
scope: ['we:scripts/check-standards-rules.mjs', 'we:scripts/merge-ai-prs.mjs']
---

# Enforce per-pass drain policy resolution and CLI gate coverage

Add a standards rule that rejects live drain settings resolved outside `sweepOnce`, preventing a long-lived watch from retaining stale operator policy. Prevention follow-up from PR #4965 and #5974.

Cover `resolve*Setting()` and equivalent policy resolvers such as `resolveDrainWorkflowEditHuman()`. Distinguish fixed invocation options from settings intended to refresh each pass. Include fixtures proving that startup-only reads fail and pass-local reads succeed.

Also assess a standards rule requiring a named CLI-spawning regression for each new `@merge-gate` loop in `runCli`, including bare and review-escalation branches. Pure decision tests cannot detect missing loop wiring.

The repair adds watch reload, bare-loop, capped-read and policy-roster regressions. This follow-up makes those obligations discoverable for future gates.
