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

## 2026-11-23 repair status

`owed-fix-default-io-smoke` is now implemented in `we:scripts/conveyor/__tests__/owed-fix-default-io.test.mjs`: the CI-heal consumer receives no recovery IO option, production command parsing/auth/release/transactions/publication run against temporary stores, and both subprocess execution paths are intercepted. It covers `fixing`, `fix` and `ci-heal` claim records, duplicate ticks, and auth/head/JSON/missing-record/corrupt-record refusals. Fix/CI-heal claims use their real acquisition function; fixing uses the shared reserve primitive with fix-procedure-shaped metadata because the launcher forbids invoking fix-procedure here. This is command-boundary simulation, not a real executable or live-host check.

The first local run had four passing refusal cases and three failing recovery cases. The fixture was then corrected to supply fixing's `who` metadata and planner hold shape, and to intercept native subprocess exports even when the daemon graph was preloaded. It has not been rerun, per the launcher's proof-only test policy. The launcher gate must establish the final result; this card stays open.

`owed-fix-babysit-followup-record`, `owed-fix-live-7307-or-7179` and the rollout check remain pending: the sandbox has no network and cannot read the external configuration or deploy a prototype. No responsible person's assignment was provided; an owner still needs to be recorded by the launcher/operator. This is not a claim that operational Acceptance items 3 or 4 are complete.
