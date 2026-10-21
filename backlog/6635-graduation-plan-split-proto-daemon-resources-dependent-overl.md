---
bornAs: x6y717a
kind: epic
status: open
dateOpened: "2026-10-20"
tags: [graduation, daemon-overlay, conveyor]
---

# Graduation plan: split proto-daemon-resources + dependent overlays into small PRs

Ordered plan to graduate lane/proto-daemon-resources (37 slices) and its ~45 dependent hotfix overlays into main as small PRs (≤300 lines / ≤8 files), excluding parked b4 parts, parked WIP and the three overlays under rework.

Operator approved 2026-10-20 ("Ok"). Operator rule: a graduation PR is SMALL — one overlay, or 2–3 closely related; roughly ≤300 changed lines and ≤8 files — because large PRs get stuck in review. This card is the plan only. No code is built here; each row below becomes its own small PR (or a `/slice` story first).

## Inventory (2026-10-20, ~12:00Z)

- **Base**: `lane/proto-daemon-resources` @ `afa17b5a4` — 43 non-merge commits, 171 files / +8575 −566 vs its merge base. After a trial merge onto `origin/main` with main's side taken in conflicts, the real residual is **160 files / +8189 −582**.
- **Trial merge conflicts with main (5 files)** — the same files the review clone's 11:51Z rebuild dropped on:
  - `we:scripts/lib/git-run.mjs` — main has the timeout signature (#5734); proto adds `inheritEnv`. Resolve: keep main's signature, add `inheritEnv` (it goes with S33).
  - `we:skills-src/conveyor/daemon-manifest.mjs` — main has `maxAttempts: 3` + `stopGraceMs` (coroner fix, landed). Resolve: take main.
  - `we:scripts/conveyor/nightly-coroner-job.mjs` + test — main's coroner fix (xgtbrr3 → #6293, #5487) supersedes proto commit `d2838536a`. Resolve: take main, no slice.
  - `we:skills-src/conveyor/review-daemon.mjs` — main added `log` (status sweep #5735); proto adds `readRedTeamRequests`. Resolve: keep both (S16).
- **Already on main, so no slice**: the `lane/overload-guard` merge (#5624), `lane/coroner-job-fix`, and the health-smells coroner files.
- **Parked b4 parts (must NOT graduate)**:
  - `lane/proto-b4-missing-check`: commit `e0d00b083`, plus the b4b missing-run parts of merge `eeb31f0f1`. Reverted on the base by `4e640e983`.
  - `lane/proto-b4-base-repair`: item 6b of `d5798cf4f`. Removed by `2e0ed84da`.
  - The net residual holds none of `we:scripts/conveyor/missing-run-rerequest.mjs`, `we:scripts/conveyor/missing-run-push.mjs`, `we:scripts/lib/conflict-finding.mjs`, `we:scripts/conveyor/main-red-recovery.mjs` or `we:scripts/settings/missing-run-rerequest.json`.
  - What stays from the b4b/b4c merges is the non-parked part: referral-hold, needs-you feed, the singleton owners. It is covered by S23–S27.
  - The regression test added by `4e640e983` (`we:scripts/conveyor/__tests__/ci-red-recovery-watch.test.mjs`, "missing-run recovery scope") goes in S37 as proof that the parked part stays out.
- **Overlay registries**: `the daemon-overlay `list --clone=<clone>` command`, plus each daemon log's `daemon-rebuild: overlay-stack-tops` line.
  - Review clone: 29 refs. Top `proto-slice0-prevention-filer`. Since 11:51Z only the slice0 stack is live. Proto and every hot-* were dropped on conflict: `overlay-conflict-unresolved` on the five files above, plus `we:scripts/lane-pool.mjs` for the children.
  - Fix clone: proto + gh-auth + rearm-cycle + stale-base-rebase. Top `hot-stale-base-rebase`.
  - Drain (plateau-app drain daemon): 27 refs. Top `hot-card-group-v2`, everything else stack-contained. Still live at 11:43Z.
  - Health-watch: top `hot-healthwatch-stack` (gh-auth + rearm-cycle + healthwatch-scan).
- **Already graduated / in flight**: hot-gh-auth (#5729, still OPEN), builder-paused (#5730), rebuild-no-starve (#5731), overlap-yield (#5732, still OPEN), stale-base-rebase (#5733), git-run-timeout (#5734), status-sweep (#5735). Stacks that carry these commits skip them when slices are cut (e.g. `1ae62e32e` in hot-squash-refuse is rebuild-no-starve).
- **Excluded (rework by another agent)**: hot-conflict-class (`bc2d5d3e9`), hot-healthwatch-scan (`77885351b`, `d6968ee0e`), hot-stalled-review (`514a999fa`). They also sit inside these stacks:
  - `bc2d5d3e9` is inside hot-carried-accept-review.
  - `514a999fa` is inside hot-redteam-sendback-review and hot-squash-union.
  - The scan commits are inside hot-healthwatch-stack.
  - Those stacks graduate by cherry-picking only their own commits and skipping the excluded ones.
- **Parked WIP (never graduates)**: hot-gh-slots-wip, hot-drain-context-cache-wip, proto-drain-pipeline-wip, hot-card-carry-wip, build-x9diisp(-wip), hot-card-round-refund-wip, proto-number-at-birth, hot-cascade-run-index-v2, hot-realfiles-*, hot-pass-queue-snapshot-wip, hot-priority-slot, hot-latent-red-*.

## How every slice is cut (applies to all rows)

1. Cut from **fresh `origin/main`** in a lane: cherry-pick the listed hunks or files. Never merge the proto branch. Never force-push.
2. Conflict files resolve as listed above. Main's side wins unless the row says otherwise.
3. Each slice carries its own section of `we:docs/agent/testing.md` (246 lines in total across all slices). It also carries the existing-test updates that its change breaks.
4. "Lines" means changed lines in the residual diff (approximate). A row over the cap says why and where its seam is.
5. **Retiring an overlay**: an overlay leaves a daemon's registry (`daemon-overlay remove`) only after:
   - its graduation PR is merged, and
   - the next rebuild's `overlay-stack-tops` no longer needs it.
   - The proto base itself retires only after S37.
6. **Gate (rebuild drops)**: every graduated slice makes the proto copy of those hunks conflict with main. That is the 11:51Z drop class.
   - Phase A touches none of the five conflict files, so it can start now.
   - Phases B–F wait on x9diisp (rebuild replay treats hunks already on main as resolved). Otherwise each merge re-drops the review and fix stacks.

## Part 1 — slices of `lane/proto-daemon-resources` (ordered)

Format: **id — name** · ~lines / files · behaviour · overlays that depend on it · live evidence · tests · depends on.

### Phase A — independent leaves (no conflict files)

1. **S01 — clone git-maintenance config** · ~110 / 5 · `we:scripts/lane-pool.mjs` (`apply-git-maintenance-config`, clones get `maintenance.auto=false`), `we:scripts/lib/lane-repair.mjs`, `we:scripts/lib/daemon-version.mjs`, `we:scripts/lib/daemon-version-migrate.mjs`, `we:scripts/__tests__/lane-pool-maintenance-config.test.mjs`.
   - Behaviour: no background `git maintenance` on pool or daemon clones.
   - Overlays: none (the children conflict on `we:scripts/lane-pool.mjs`, so landing this early lowers re-drops).
   - Evidence: review and fix clones read `maintenance.auto=false`.
   - Tests: `we:scripts/__tests__/lane-pool-maintenance-config.test.mjs`.
   - Depends on: none.
2. **S02 — batched drain PR state** · ~150 / 4 · `we:scripts/lib/drain-pr-state.mjs` + test, `we:scripts/settings/drain-pr-state.json`, `we:scripts/merge-ai-prs.mjs` (prState hunks only).
   - Behaviour: one batched PR-state read per drain pass, used to seed the per-PR reads.
   - Overlays: proto-b5 drain stack.
   - Evidence: drain log `policy · drain.prState.batched=true` (90 passes).
   - Tests: `we:scripts/lib/__tests__/drain-pr-state.test.mjs`.
   - Depends on: none.
3. **S03 — label TTL cache** · ~200 / 5 · `we:scripts/lib/label-cache.mjs` + test, `we:scripts/lib/review-label-provider.mjs` + test, `we:scripts/merge-ai-prs.mjs` (label-ensure hunks).
   - Behaviour: `gh label create` runs once per TTL, not once per pass.
   - Overlays: none.
   - Evidence: drain still live on it (stack-contained at 11:43Z).
   - Tests: `we:scripts/lib/__tests__/label-cache.test.mjs`, `we:scripts/lib/__tests__/review-label-provider.test.mjs`.
   - Depends on: S02 (same file, `we:scripts/merge-ai-prs.mjs`).
4. **S04 — label cache consumers** · ~40 / 5 · `we:scripts/lib/forge-land-provider.mjs` + test, `we:scripts/conveyor/fix-push-ci.mjs` + test, `we:scripts/conveyor/stand-down.mjs`.
   - Tests: `we:scripts/lib/__tests__/forge-land-provider.test.mjs`, `we:scripts/conveyor/__tests__/fix-push-ci.test.mjs`.
   - Depends on: S03.
5. **S09 — saved red-team provenance primitive** · ~225 / 3 · `we:scripts/lib/saved-red-team-provenance.mjs` + test + `we:scripts/lib/__tests__/fixtures/saved-red-team-provenance.mjs`.
   - Behaviour: a saved red-team row counts only with verified head/run provenance.
   - Overlays: the whole red-team chain.
   - Evidence: drain log `saved-red-team-ignored: no matching completed saved result` (152 provenance lines).
   - Tests: `we:scripts/lib/__tests__/saved-red-team-provenance.test.mjs`.
   - Depends on: none.
6. **S28 — collector retires a stuck sealed batch from GitHub truth (x5nmdnt)** · ~210 / 3 · `we:scripts/operations/card-batch-io.mjs`, `we:scripts/operations/card-batch-seal-io.mjs`, `we:scripts/operations/__tests__/card-batch-io.test.mjs` (retire cases).
   - Note: PR #5612 was closed on 2026-10-19 so this lands as a graduation PR.
   - Tests: `we:scripts/operations/__tests__/card-batch-io.test.mjs`.
   - Depends on: none.
7. **S29 — sealed-member dedupe + recovery guarantees** · ~340 / 3 (over the cap by test cases only; ~25 lines of code) · same two `card-batch-*-io.mjs` files + test, `we:backlog/xuloryt-prevention-require-named-refusal-cases-for-recovery-evidence.md`.
   - Seam if review balks: move the test cases for the xuloryt named refusals into their own PR.
   - Depends on: S28.
8. **S30 — card-batch reconcile operation** · ~240 / 4 · `we:scripts/operations/card-batch-reconcile.mjs` + test, `we:scripts/operations/__tests__/card-batch-seal-io.test.mjs`, `we:scripts/settings/card-batch.json`.
   - Behaviour: retires merged/closed sealed batches (needs a fresh MERGED/CLOSED read), drains pending prevention, flushes.
   - Tests: `we:scripts/operations/__tests__/card-batch-reconcile.test.mjs`, `we:scripts/operations/__tests__/card-batch-seal-io.test.mjs`.
   - Depends on: S29.
9. **S31 — health-watch runs the periodic reconcile** · ~50 / 2 · `we:scripts/conveyor/health-watch.mjs` + test.
   - Evidence: health-watch clone (top `hot-healthwatch-stack`).
   - Tests: `we:scripts/conveyor/__tests__/health-watch.test.mjs`.
   - Depends on: S30. Lands before the healthwatch-scan rework so the two do not collide.
10. **S36 — restamp uses the gated code clone** · ~45 / 2 · `we:scripts/merge-ai-prs.mjs` (`restampAcceptance` hunk), `we:scripts/__tests__/merge-ai-prs-restamp-local-repo.test.mjs`.
    - Behaviour: a drain restamp runs review-set-label from the drain's gated CODE clone, not stale DATA.
    - Depends on: S03 (same file).

### Phase B — review reads (after the x9diisp gate)

11. **S05 — per-tick shared review fetch + guards read direct** · ~280 / 9 (one file over: the guard proof must ship with the cache, or guards would read cached data for one release) · `we:scripts/lib/review-fetch.mjs` + test, `we:skills-src/conveyor/review-daemon.mjs` (`withReviewFetchTick`), `we:scripts/conveyor/__tests__/guard-readers-direct-fetch.test.mjs`, `we:scripts/conveyor/mechanical-round-cap.mjs` + test, `we:scripts/conveyor/reconcile-pass.mjs`, `we:scripts/operations/review-pr-io.mjs` / `we:scripts/review-set-label.mjs` / `we:scripts/operations/review-dispatch.mjs` (fetch hunks).
    - Tests: `we:scripts/lib/__tests__/review-fetch.test.mjs`, `we:scripts/conveyor/__tests__/guard-readers-direct-fetch.test.mjs`, `we:scripts/conveyor/__tests__/mechanical-round-cap.test.mjs`, `we:scripts/operations/__tests__/review-dispatch.test.mjs`.
    - Depends on: gate.
12. **S06 — per-head PR snapshot** · ~260 / 5 · `we:scripts/lib/review-pr-snapshot.mjs` + test, `we:scripts/review-detail.mjs`, snapshot hunks of `we:scripts/operations/review-extra-seats.mjs` and `we:scripts/operations/review-pr-io.mjs`.
    - Tests: `we:scripts/lib/__tests__/review-pr-snapshot.test.mjs`.
    - Depends on: S05.
13. **S07 — juror/fixer PR reads go through the snapshot** · ~270 / 8 · `we:scripts/pr-context.mjs`, `we:scripts/lib/__tests__/pr-context-sharing.test.mjs`, `we:scripts/conveyor/fix-context-pack.mjs`, `we:scripts/conveyor/fix-round-history.mjs` + test, `we:scripts/conveyor/reconcile-fix-dispatch.mjs`, `we:scripts/operations/ci-heal-pr-dispatch.mjs`, `we:scripts/operations/review-pr.mjs` (hunk).
    - Tests: `we:scripts/lib/__tests__/pr-context-sharing.test.mjs`, `we:scripts/conveyor/__tests__/fix-round-history.test.mjs`.
    - Depends on: S06.
14. **S08 — PR-read inventory doc + fixer brief** · ~160 / 2 (docs only) · `we:docs/agent/pr-read-inventory.md`, `we:skills-src/conveyor/fix-agent-brief.md`.
    - Depends on: S07.

### Phase C — red team (saved results, panel seat, drain requests)

15. **S10 — saved red-team reader** · ~450 / 2 (over the cap by tests only: 74 lines of code + 374 lines of tests) · `we:scripts/lib/drain-saved-red-team.mjs` + test.
    - Seam: split the test into the reader cases (land here) and the panel-seat-row cases (land with S14).
    - Tests: `we:scripts/lib/__tests__/drain-saved-red-team.test.mjs`.
    - Depends on: S09.
16. **S11 — drain red-team evidence + gate + policy** · ~300 / 7 · `we:scripts/lib/drain-red-team-evidence.mjs` + test, `we:scripts/lib/red-team-gate.mjs`, `we:scripts/operations/red-team-gate-apply.mjs` + test, `we:scripts/lib/review-red-team-policy.mjs`, `we:scripts/lib/__tests__/red-team-timing.test.mjs`.
    - Behaviour: `redTeam.timing=panel-seat` policy; evidence is read through the provenance check.
    - Tests: `we:scripts/lib/__tests__/drain-red-team-evidence.test.mjs`, `we:scripts/operations/__tests__/red-team-gate-apply.test.mjs`, `we:scripts/lib/__tests__/red-team-timing.test.mjs`.
    - Depends on: S10.
17. **S12 — queue safety + saved-result hold in the drain strategy** · ~250 / 5 · `we:scripts/lib/drain-queue-safety.mjs` + test, `we:scripts/settings/drain-queue-safety.json`, `we:scripts/lib/drain-merge-strategy.mjs` (hold hunks) + test (hold cases).
    - Tests: `we:scripts/lib/__tests__/drain-queue-safety.test.mjs`, `we:scripts/lib/__tests__/drain-merge-strategy.test.mjs`.
    - Depends on: S11.
18. **S13 — drain requests a red team per head (xogmcq9)** · ~260 / 4 · `we:scripts/lib/drain-red-team-requests.mjs`, `we:scripts/lib/drain-merge-strategy.mjs` (request, cooldown and W1 "refuse recorded/attempted first" hunks) + test cases, `we:scripts/merge-ai-prs.mjs` (`requestRedTeam` wiring).
    - Evidence: drain log `red team requested` (70) and review log (231).
    - Tests: `we:scripts/lib/__tests__/drain-merge-strategy.test.mjs`.
    - Depends on: S12, S36.
19. **S14 — red team as a panel seat** · ~300 / 5 · `we:scripts/operations/review-extra-seats.mjs` + test, `we:scripts/operations/__tests__/review-red-team-seat.test.mjs`, `we:scripts/operations/review-pr-completion.mjs`, `we:scripts/operations/review-pr.mjs` (seat hunk).
    - Tests: those three test files plus `we:scripts/lib/__tests__/drain-red-team-seat.test.mjs`.
    - Depends on: S11, S06.
20. **S15 — seat resume + review-job red-team path** · ~290 / 6 · `we:scripts/operations/review-job.mjs` (red-team hunks), `we:scripts/operations/__tests__/review-red-team-seat-resume.test.mjs`, `we:scripts/operations/__tests__/review-job-red-team.test.mjs`, `we:scripts/operations/__tests__/review-job.test.mjs`, `we:scripts/operations/__tests__/review-red-team.test.mjs` / `we:scripts/operations/__tests__/review-job-speculative-red-team.test.mjs` (provenance-fixture updates).
    - Seam if over: the fixture-only test updates become their own PR.
    - Depends on: S14.
21. **S16 — review daemon consumes drain red-team requests** · ~300 / 8 · `we:scripts/lib/drain-red-team-review.mjs`, `we:scripts/operations/__tests__/review-job-drain-red-team.test.mjs`, `we:scripts/operations/review-antigravity-policy.mjs`, `we:scripts/operations/review-seat-policy.mjs`, `we:scripts/operations/review-dispatch.mjs`, `we:scripts/operations/review-job.mjs` (hunk), `we:skills-src/conveyor/review-daemon.mjs` + test.
    - Resolve the review-daemon conflict here: keep main's `log` and add `readRedTeamRequests`.
    - Tests: `we:scripts/operations/__tests__/review-job-drain-red-team.test.mjs`, `we:skills-src/conveyor/__tests__/review-daemon.test.mjs`.
    - Depends on: S13, S15.
22. **S17 — round-cap / human-hold soak breaks + operator queue** · ~190 / 7 · `we:scripts/conveyor/soak/breaks/saved-red-team-round-cap-unclearable.mjs` (+ its soak test), `we:scripts/conveyor/soak/breaks/approved-human-head-review-churn.mjs`, `we:scripts/review-set-label.mjs` (clear-human-hold hunk) + `we:scripts/__tests__/review-set-label-clear-human-hold.test.mjs`, `we:scripts/operations/operator-queue.mjs` / `we:scripts/operations/operator-why-io.mjs` (hunks) + `we:scripts/operations/__tests__/operator-queue-entry.test.mjs`.
    - Tests: those tests + the soak breaks.
    - Depends on: S15.

### Phase D — referrals, rulings, PR owners

23. **S18 — run-record / run-store plumbing for the restamp** · ~90 / 8 · `we:scripts/operations/run-record.mjs`, `we:scripts/operations/run-store.mjs` + test, `we:scripts/operations/cli-adapter.mjs`, `we:scripts/operations/review-loop-cli.mjs` (hunk), small test updates (`item-activity-io-real`, `review-seat-timing`, `review-ruling-resume`, `build-dispatch-tick-speed`).
    - Depends on: gate.
24. **S19 — numbering-carry restamps referrals (#5520 core)** · ~300 / 3 · `we:scripts/lib/numbering-carry.mjs` (restamp half) + `we:scripts/lib/__tests__/numbering-carry.test.mjs` + `we:scripts/lib/__tests__/numbering-carry-referral.test.mjs` (restamp describe blocks only).
    - Depends on: S18.
25. **S20 — numbering-carry bypass fix** · ~340 / 3 (over by tests; the 561-line referral test file is split between S19 and S20) · rest of `we:scripts/lib/numbering-carry.mjs` + the rest of `we:scripts/lib/__tests__/numbering-carry-referral.test.mjs` + `we:scripts/__tests__/review-referral-acceptance.test.mjs`.
    - Depends on: S19.
26. **S21 — soak break: numbering carry, unfinished live review** · ~115 / 2 · `we:scripts/conveyor/soak/breaks/numbering-carry-unfinished-live-review.mjs` + its soak test.
    - Depends on: S20.
27. **S22 — auto-policy block yields to evidenced not-real; ruling-slug alias; jury-core repo aliases** · ~300 / 7 · `we:scripts/lib/jury-core.mjs` + test, `we:scripts/lib/ruling-ledger.mjs`, `we:scripts/lib/review-settings.mjs` + test, `we:scripts/conveyor/reconcile-core.mjs` (hunk), `we:scripts/conveyor/__tests__/referral-auto-block.test.mjs`.
    - Tests: `we:scripts/conveyor/__tests__/referral-auto-block.test.mjs`, `we:scripts/lib/__tests__/jury-core.test.mjs`, `we:scripts/lib/__tests__/review-settings.test.mjs`.
    - Depends on: gate.
28. **S23 — no fixer pass on a cleared head for card/not-real findings (x84m5n2) + import-cycle fix** · ~170 / 5 · `we:scripts/conveyor/review-referral-hold.mjs` (fixer-suppression hunks) + test part, `we:scripts/conveyor/reconcile-core.mjs` (hunk), `we:scripts/conveyor/advisory-fix-mark.mjs` (`9faefe6fd`, the REARM_COMMENT_MARKER cycle).
    - Evidence: the fix daemon has booted on it since 10-18.
    - Tests: `we:scripts/conveyor/__tests__/review-referral-hold.test.mjs`, `we:scripts/__tests__/review-referral-acceptance.test.mjs`.
    - Depends on: S22.
29. **S24 — repo-alias canonicalisation at the ruling-vs-record comparisons** · ~180 / 8 · `we:scripts/conveyor/ruling-resolved-stand-down.mjs` + test, `we:scripts/operations/record-referral-ruling.mjs` + test, `we:scripts/operations/coroner-false-findings.mjs` + test, `we:scripts/operations/review-pr-io.mjs` + test.
    - Depends on: S23.
30. **S25 — paused-on-referrals review raises ruling-needed, re-arms once per head** · ~230 / 6 · `we:scripts/conveyor/review-referral-hold.mjs` (pause hunk) + test, `we:scripts/operations/needs-you-feed.mjs` + test, `we:scripts/operations/operator-queue.mjs` (hunk), `we:skills-src/conveyor/review-daemon.mjs` (hunk) + test.
    - Evidence: `ruling-needed` lines in the review log (113) and fix log (107).
    - Depends on: S24, S16.
31. **S26 — single-source ci-heal owed + rearm owner (bundles overlay hot-rearm-cycle)** · ~230 / 7 · `we:scripts/conveyor/ci-heal-rule.mjs`, `we:scripts/conveyor/rearm-review.mjs`, `we:scripts/conveyor/reconcile-core.mjs`, `we:scripts/conveyor/tick-core.mjs`, `we:scripts/conveyor/__tests__/pr-singleton-owners.test.mjs` (ci-heal/rearm cases), `we:scripts/__tests__/review-referral-acceptance.test.mjs`.
    - Also takes hot-rearm-cycle `66915b14d` (+30, breaks the rearm-review → reconcile-core import cycle that this slice introduces).
    - Retires: hot-rearm-cycle (review, fix, drain, health).
    - Depends on: S23.
32. **S27 — promote-draft owner + needs-person** · ~120 / 5 · `we:scripts/operations/promote-draft-pr-dispatch.mjs`, `we:scripts/operations/operator-queue-needs-person.mjs` + test, `we:scripts/operations/operator-queue.mjs` (hunk), rest of `we:scripts/conveyor/__tests__/pr-singleton-owners.test.mjs`.
    - Depends on: S26.

### Phase E — card conflicts + prevention filing

33. **S32 — Also-raised-by union resolver** · ~310 / 4 · `we:scripts/lib/card-conflict-resolve.mjs` + test, `we:scripts/lib/rebase-drop-manifest.mjs`, `we:scripts/settings/card-conflicts.json`.
    - Evidence: review log `union` lines (122).
    - Tests: `we:scripts/lib/__tests__/card-conflict-resolve.test.mjs`.
    - Depends on: gate.
34. **S33 — card-only rebase owner in conflict-watch (+ constellation clone check first, + `inheritEnv`)** · ~305 / 3 · `we:scripts/conveyor/parked-pr-conflict-watch.mjs`, `we:scripts/conveyor/__tests__/card-conflict-owner.test.mjs`, `we:scripts/lib/git-run.mjs`.
    - `inheritEnv` is added on top of main's timeout signature; its only caller is the credential-pinned push in conflict-watch.
    - Tests: `we:scripts/conveyor/__tests__/card-conflict-owner.test.mjs`, `we:scripts/lib/__tests__/git-run.test.mjs`.
    - Depends on: S32.
35. **S34 — prevention filing pause + owed record** · ~250 / 6 · `we:scripts/lib/prevention-filing-owed.mjs`, `we:scripts/lib/prevention-landing-job.mjs`, `we:scripts/lib/__tests__/prevention-filing-pause.test.mjs`, `we:scripts/lib/card-batch-settings.mjs` + test, `we:scripts/settings/prevention-batch.json`.
    - Evidence: health-watch log `prevention filing paused by prevention.filingEnabled` (169).
    - Depends on: S30.
36. **S35 — prevention-pause callers** · ~80 / 6 · `we:scripts/operations/land-prevention-card.mjs` + test, `we:scripts/review-set-label.mjs` (hunk) + `we:scripts/__tests__/review-set-label.approval-prevention-filing.test.mjs`, `we:scripts/operations/review-loop-cli.mjs` + test.
    - Depends on: S34, S17.

### Phase F — close-out

37. **S37 — guard-audit regression proofs** · ~70 / 3 · `we:scripts/conveyor/__tests__/guard-audit-regressions.test.mjs`, `we:scripts/conveyor/__tests__/reconcile-core.test.mjs` (hunk), `we:scripts/conveyor/__tests__/ci-red-recovery-watch.test.mjs` (parked b4 stays out).
    - These pin that the 10 audited weakenings are "at least as strict as main" across slices.
    - Then: `daemon-overlay remove lane/proto-daemon-resources` on the review, fix and drain clones.
    - Depends on: every S slice.

## Part 2 — dependent overlays mapped onto slices

Sizes are each overlay's own commits (not merges of main, and not its parent overlay). "G" rows are review/health stack PRs; "B" rows are the drain stack.

### Review stack (conflict-watch, red team)

| id | overlay(s) → PR | ~lines / files | after | retires |
|---|---|---|---|---|
| G1 | hot-conflict-watch-log + hot-card-detect + hot-card-headoid | 175 / 2 | S33 | those 3 (review) |
| G2 | hot-carried-accept-review `9b1637e63` (resolved count, attempt marker, unownedRebase) | 333 / 6 (over; one commit, 2 code files) | G1 | — (with G9) |
| G3 | hot-infra-retry-cap | 275 / 4 | G2 | hot-infra-retry-cap |
| G4 | hot-card-resolver-fix | 256 / 6 | S32, G3 | hot-card-resolver-fix |
| G5 | hot-rearm-fail4 own `cbb7de115` (rearm only when a verdict is live) | 96 / 2 | S26, G4 | hot-rearm-fail4 (its gh-auth/rearm-cycle parts graduate via #5729 / S26) |
| G6 | hot-card-git-files | 135 / 5 | G5 | hot-card-git-files |
| G7 | hot-redteam-request `d471d4b81` + hot-redteam-complete | 208 / 8 | S13, S26 | both (review); hot-redteam-request (drain) |
| G8 | hot-carried-accept-review `d9577a059` (carried accept with no head evidence gets a fresh capped review) | 221 / 6 | S15, G7 | hot-carried-accept-review (once G2+G8 land; `bc2d5d3e9` skipped, excluded) |
| G9a | hot-redteam-cardonly — drain half (`drain-queue-safety`, `red-team-gate`, `review-red-team-policy`, `red-team-gate-apply` + tests) | ~120 / 8 | S12, S11 | — |
| G9b | hot-redteam-cardonly — review half (`review-loop-cli`, `review-set-label`, `prevention-filing-pause.test`) | ~65 / 5 | G9a, S35 | hot-redteam-cardonly (review, drain) |
| G10 | hot-redmain-review own `da17e9994` (seat the main-fix PR's red-team request first) | 29 / 2 | G9b | hot-redmain-review |
| G11 | hot-redteam-sendback-review own `994e676be` + hot-redteam-stuck-review | 133 / 8 | S16, G10 | both (`514a999fa` skipped, excluded) |
| G12a | rtg-grants-review-overlay `8bbfb2660` (honour operator round grants) | 271 / 12 (over on files: split the 12 into gate+tests and the seat callers) | S11, G11 | — |
| G12b | rtg-grants-review-overlay `275ed8fb2` (credit grants only for the PR's own repo) | 82 / 8 | G12a | rtg-grants-review-overlay |
| — | hot-review-stack | 0 own commits (stack ref) | — | removed when its members are retired, no PR |

### Card-squash feature (review + drain deltas of hot-card-clean-rebase)

This one is too big for one PR: 934 lines / 24 files on the review side, plus 776 / 22 on the drain side. Split by seam into new libraries first, then the wiring.

| id | content | ~lines / files | after |
|---|---|---|---|
| Q1 | `we:scripts/lib/card-squash-marker.mjs` + test | ~200 / 2 | S33 |
| Q2 | `we:scripts/lib/pr-real-files.mjs` + test, `we:scripts/lib/pr-limit.mjs` + test | ~250 / 4 | — |
| Q3 | `we:scripts/lib/card-squash-rebuild.mjs` + test | ~300 / 2 | Q1, Q2 |
| Q4 | review wiring (`parked-pr-conflict-watch`, `mechanical-round-cap`, `reconcile-core` + `mechanical-rebase-rounds.test`) | ~250 / 6 | Q3 → retires hot-card-clean-rebase-review |
| Q5 | drain wiring (`we:scripts/operations/card-rebase-probe.mjs`, `we:scripts/settings/card-rebase.json`, open-pr-cap scope, `gitRecheckFiles` default) | ~280 / 8 | Q4 → retires hot-card-clean-rebase-drain |
| Q6 | hot-squash-union own `52aad7e52` (proof checks union-resolved blobs) | 149 / 7 | Q4 → retires hot-squash-union (`514a999fa` skipped) |
| Q7 | hot-squash-refuse `f6f6922c1` + `22849fb60` (per-path merge proof + runner-contract guard) | 361 / 2 (over by tests; 2 files) | Q6 → retires hot-squash-refuse (`1ae62e32e` already = #5731) |

Evidence: drain log `cardRebase.squashToSingleCommit=true`; review/drain `squash` lines (124 / 115).

### Drain stack (base `lane/proto-b5`, after S13 since they share `we:scripts/lib/drain-merge-strategy.mjs` / `we:scripts/merge-ai-prs.mjs`)

| id | overlay(s) → PR | ~lines / files | after | retires |
|---|---|---|---|---|
| B1 | proto-b5 `96b7e92cf` (hold-first, honest skip reasons, catch-up dedupe, carry-over) | 325 / 8 | S13 | — |
| B2 | proto-b5 `05f8f102a` + `514e289b6` (live sibling state; read-only holdOnly) | 282 / 7 | B1 | proto-b5 |
| B3 | hot-catchup-skip-ttl own `ea4c8f4fa` + hot-catchup-skip-fix | 212 / 5 | B2, G7 | both |
| B4 | hot-redmain-drain own `2c94382bb` (main-fix PR first in event loop + review consumer) | 232 / 10 (over on files; split event loop from review consumer) | B3, G10 | hot-redmain-drain |
| B5 | hot-queue-card-overlap-v2 (never enqueue a PR sharing a file with a queued PR) | 214 / 10 (over on files; split `queue-file-overlap` lib+test from the callers) | B4 | hot-queue-card-overlap-v2 |
| B6 | hot-overlap-first | 233 / 7 | B5, #5732 | hot-overlap-first |
| B7 | hot-redteam-while-waiting | 320 / 3 (slightly over; 3 files) | B6 | hot-redteam-while-waiting |
| B8 | hot-plateau-redteam + hot-redteam-stuck-drain | 80 / 4 | B7, G11 | both |
| B9 | hot-priority-reserve `307726533` | 315 / 8 | Q5, B8 | — |
| B10 | hot-priority-reserve `cf7335a96` + hot-5715-enqueue | 268 / 8 | B9 | hot-priority-reserve, hot-5715-enqueue |
| B11 | hot-priority-reserve-rt | 263 / 8 | B10 | hot-priority-reserve-rt |
| B12 | hot-cardonly-newhead | 97 / 4 | B11, G9a | hot-cardonly-newhead |
| B13 | hot-card-overlap-clean `76c1466c9` | 265 / 5 | B12 | — |
| B14 | hot-card-overlap-clean 3 follow-up fixes | 87 / 7 | B13 | hot-card-overlap-clean |
| B15 | hot-catchup-round-snapshot + hot-queue-read-failclosed | 257 / 7 | B14, S06 | both |
| B16 | hot-numbering-sidecar + hot-catchup-stale-pending-v2 | 112 / 4 | B15 | both |
| — | hot-drain-stack | 0 own commits | — | removed once members retire, no PR |

Evidence for the drain rows: all of them are live in the drain daemon (stack-contained under `hot-card-group-v2`, 11:43Z). Logs show `overlap-yield` (4460), `catch-up` (8734), `priority reserve` (32) and `card-only` (72). The 11:55Z log shows `queue-file-overlap: #5737,#5662 share backlog/…` holding a catch-up.

### Health-watch and fix stacks

- **hot-healthwatch-stack** = gh-auth + rearm-cycle + hot-healthwatch-scan. Nothing of its own to graduate. It retires once #5729, S26 and the scan rework (other agent) all land.
- **Fix clone**: retires proto after S37, gh-auth after #5729, rearm-cycle after S26. stale-base-rebase is already #5733 (remove it now if the rebuild agrees).

## Cannot graduate (or not via this plan)

- **hot-conflict-class, hot-healthwatch-scan, hot-stalled-review**: being reworked by another agent. Their commits are skipped inside the stacks that carry them (hot-carried-accept-review, hot-redteam-sendback-review, hot-squash-union, hot-healthwatch-stack).
- **hot-card-group-v2** (1264 / 6 own lines, mostly `we:scripts/lib/card-group.mjs` + test): a new feature, not a hotfix. It needs its own `/slice` (lib core, audit fixes, proof rules, drain wiring) before it can meet the size rule. Until then it stays the drain overlay top.
- **proto-slice0-number-at-birth + proto-slice0-prevention-filer**: a different prototype (epic 6122 slice 0). It merges cleanly with main and is not on proto-daemon-resources, so it graduates under its own card (4 commits, 961 / 19 → needs its own split).
- **proto-b4-base-repair, proto-b4-missing-check**: parked. Their parts are already reverted on the base; S37 pins that they stay out.
- **#5729 (gh-auth) and #5732 (overlap-yield) are still OPEN**: B6 and the health and fix retirements wait on them.

## Acceptance

- [A1] **Executable** — after the last row lands:
  - the daemon-overlay `list` command for the review and fix clones lists none of `lane/proto-daemon-resources` or the overlays marked "retires" above;
  - `git merge-tree --write-tree origin/main origin/lane/proto-daemon-resources` leaves a tree whose diff against `origin/main` contains no non-parked behaviour.
- [A2] Every graduation PR is ≤300 changed lines and ≤8 files, or its row above names the exception and why.
- [A3] Every slice is cut from fresh main, never by merging the proto branch, and none is force-pushed.

## Non-goals

- [N1] Building or changing any code here. This card is the plan; each row is its own PR.
- [N2] Graduating parked WIP, the parked b4 branches, or the three overlays under rework.
- [N3] Fixing the rebuild-drop class itself. That is x9diisp; this plan only orders around it.

## Edge cases this change must handle

1. **Untrusted text** — n/a: a plan card; no input is parsed.
2. **Truncated reads** — the inventory came from full `git` reads and the latest `overlay-stack-tops` lines. Re-read both before cutting each slice, because the stacks move.
3. **Shared state files** — overlay registries are touched only through `daemon-overlay remove`, and only after merge plus a rebuild that agrees.
4. **Fail closed** — any slice that fails to cherry-pick cleanly onto main stops and re-cuts. It is never forced.
5. **Identity scoping** — each overlay retires per clone (review / fix / drain / health), not globally.
6. **State over time** — line counts are from 2026-10-20 ~12:00Z. Re-measure each slice from the residual diff when it is cut.
7. **Who wrote it** — operator-approved plan (2026-10-20). Rows are a split proposal, not a ruling on behaviour.
