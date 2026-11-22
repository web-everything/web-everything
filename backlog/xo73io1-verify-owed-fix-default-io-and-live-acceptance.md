---
kind: task
status: open
dateOpened: "2026-11-22"
tags: [conveyor, testing]
scope: ["we:scripts/conveyor/owed-fix-recovery.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs", "we:docs/agent/testing.md"]
---

# Verify owed-fix default IO and record the live acceptance evidence

PR #7336's 2026-11-22 review requires a hermetic default-IO smoke and named operational evidence. The offline repair cannot load a prototype, read live PRs, or verify the external babysit-label follow-up. Unit and soak simulations do not satisfy that acceptance.

## Acceptance

- `owed-fix-default-io-smoke`: exercise real temporary lock directories, real conditional release and sidecar persistence, with stub executables for gh and claude. Drive the consumer entry point with production IO defaults; observe one release/dispatch after 30 minutes and one needs-you publication plus one stream line after the next missed window. Block all unintended external writes and network calls.
- `owed-fix-babysit-followup-record`: locate the external babysit-label configuration and record a durable follow-up card identifier, its owner, and its acceptance assertion on PR #7336. This card tracks that outstanding check; the earlier claim that it was already carded has no supplied identifier.
- `owed-fix-live-7307-or-7179`: after prototype load, record checkout/head, UTC observations, selected PR and exact PR head, absent fixer evidence, claim before/after, first redispatch, suppressed duplicate tick, and subsequent escalation outputs. Stop if a live fixer, park, draft, auth pause or verification hold appears. If the original PRs no longer qualify, record that result and obtain a suitable case; do not manufacture a live failure.
- Before closing this card, post the live-proof result on PR #7336 and map each of its four Acceptance items to a named test or operational check with an observable result. Missing evidence stays pending.
- `owed-fix-kind-key-rollout`: inspect whether the prototype already wrote unscoped repo/PR/head sidecars. The corrected repo/PR/head/kind key starts separate allowances; old records contain no kind and cannot be safely attributed automatically. Record any affected heads and disposition before loading the prototype; do not claim cross-version deduplication from the new-kind tests.

## Test and proof plan

Keep the hermetic smoke separate from the operational record. The smoke must fail for missing/unreadable claims, changed heads, failed auth, and duplicate recovery. Include the raw bounded output and exit status in the PR evidence. A passing unit suite cannot mark the live check complete.
