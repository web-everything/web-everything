/** Shared protected-path vocabulary. Data only: no settings resolution or runtime IO. */
/**
 * Built-in protected paths: the concurrency modules (locks, leases, slots, lane pool, merge, drain), the guard hooks
 * with their registration, the git hooks and merge/review gates, and the auditor itself (PR #6381 red team:
 * `scripts/guard-bash.mjs` and `scripts/lib/lane-lease.mjs` were missing).
 * Every audit path list starts from this floor; settings and env can only ADD to it.
 */
/**
 * Review authorization: WHO may clear, accept, carry or escalate a verdict, and which markers are trusted (PR #6381
 * red team: scripts/lib/review-independence.mjs, the author-cannot-clear-own-review check, was missing). A test reads
 * every module these entries match from the source and pins each module it imports DIRECTLY onto the floor, so the
 * scanned set is this list itself and can never drift from it. The scan is one level deep: the full import closure
 * of this family is most of scripts/, so a module two imports away is protected only if it is named here.
 */
export const REVIEW_AUTH_FLOOR = Object.freeze([
  // AUTH-BOUND-APPROVAL: the pinned approval trust root (App id, operator allowlist) and its writer.
  'scripts/lib/approval-record.mjs', 'scripts/operations/approve-head.mjs',
  'scripts/lib/review-independence.mjs', 'scripts/lib/marker-authorship.mjs', 'scripts/lib/ai-pr-authorship.mjs',
  'scripts/operations/build-pr-authorship.mjs', 'scripts/**/human-clearance-carry*', 'scripts/settings/*human-clearance*',
  'scripts/**/accept-carry-*', 'scripts/lib/unattended-review-accept.mjs', 'scripts/lib/trust-chain-tier.mjs',
  'scripts/review-set-label.mjs', 'scripts/**/*verdict-carry*', 'scripts/**/*clear-human*', 'scripts/lib/operator-identity.mjs',
  'scripts/lib/delegation-marker.mjs', 'scripts/lib/verdict-ledger*', 'scripts/lib/ruling-ledger.mjs', 'scripts/lib/jury-core.mjs',
  // Each operation with its -io and -cli halves: the I/O half performs the write the pure half decides.
  'scripts/operations/record-verdict*', 'scripts/operations/record-referral-ruling*', 'scripts/operations/land-human-only*',
  'scripts/conveyor/hiccup-approve.mjs', 'scripts/settings/delivery-identity.json', 'scripts/lib/review-escalation.mjs',
  'scripts/lib/identical-net-patch.mjs', 'scripts/lib/carry-equivalence.mjs', 'scripts/lib/numbering-carry.mjs',
  // Landed on main since: the mixed numbering+merge chain prover (imported by numbering-carry) and the carried-acceptance
  // provenance note (imported by rebase-verdict-carry) — direct imports of the review authorization family.
  'scripts/lib/carry-chain.mjs', 'scripts/lib/carried-provenance.mjs',
  // PR #6713: the producer shapes of the trusted-author refresh and manual R247 notes (imported by accept-carry-forward): they decide
  // which operator notes the accept carry-forward ignores, so weakening them weakens the carry.
  'scripts/operations/operator-action-shape.mjs',
  // PR #6381 self-review: the operator's ruling on a confirmed red-team break (twin of record-referral-ruling), the
  // standing ruling and the ruling that answers a stand-down, the ledger backfill of rulings, the human-only enqueue
  // license, the approved-human-surface hold and the verdict hold of a PR's state.
  'scripts/operations/record-red-team-ruling*', 'scripts/conveyor/standing-ruling-mark.mjs', 'scripts/conveyor/ruling-resolved-stand-down.mjs',
  'scripts/operations/ledger-backfill-rulings.mjs', 'scripts/lib/human-only-enqueue-license.mjs', 'scripts/settings/human-only-enqueue.json',
  'scripts/lib/approved-human-surface-hold.mjs', 'scripts/settings/approved-human-surface-hold.json', 'scripts/lib/pr-state/holds/verdict.mjs',
  // `**/` needs at least one folder here, so each `scripts/**/` entry above has a twin for a file directly in scripts/.
  'scripts/*human-clearance-carry*', 'scripts/accept-carry-*', 'scripts/*verdict-carry*', 'scripts/*clear-human*']);
/**
 * The auditor itself: weakening it weakens every later audit. Like REVIEW_AUTH_FLOOR, a test reads every module these
 * entries match and pins each module it imports DIRECTLY onto the floor (PR #6381 judge: audit-verdict.mjs delegates
 * protected-path classification to audit-path.mjs, which was missing). codex-direct-task.mjs is the launcher
 * codex-audit-io.mjs spawns to produce the audit report, so it is a root too.
 */
export const AUDITOR_FLOOR = Object.freeze([
  'scripts/operations/audit-verdict.mjs', 'scripts/operations/codex-audit*',
  'scripts/lib/audit-settings.mjs', 'scripts/lib/audit-path.mjs', 'scripts/lib/policy-cascade.mjs', 'scripts/settings/codex-audit.json',
  'scripts/codex-direct-task.mjs', 'scripts/lib/audit-finding-key.mjs', 'scripts/operations/audit-base-repro.mjs']);
/** Modules the auditor imports or launches directly that no other floor entry names (the source-scan test pins each). */
const AUDITOR_IMPORTS = Object.freeze(['scripts/lib/protected-path-floor.mjs',
  'scripts/lib/guard-path-floor.mjs', 'scripts/lib/guard-auditor-roots.json',
  'scripts/lib/net-diff-fingerprint.mjs', 'scripts/lib/under-test.mjs',
  // The audit launcher's imports, and the transcript-check settings its policy reads.
  'scripts/lib/codex-transcript-policy.mjs', 'scripts/lib/codex-transcript-check.mjs', 'scripts/settings/codex-transcript-check.json',
  'scripts/lib/build-policy.mjs', 'scripts/lib/build-self-review.mjs', 'scripts/lib/lane-git-hardening.mjs',
  'scripts/lib/codex-usage-ledger.mjs', 'scripts/lib/codex-model-routing.mjs', 'scripts/lib/codex-task-route.mjs',
  // policy-cascade.mjs classifies a setting change's direction with it (loosening vs tightening).
  'scripts/lib/settings-safe-direction.mjs']);
/** Modules the review authorization family imports directly (the source-scan test pins this list complete). */
const REVIEW_AUTH_IMPORTS = Object.freeze([
  'scripts/lib/github-app-identity.mjs', 'scripts/lib/approval-prevention-notice.mjs', 'scripts/lib/review-verdict-carried-marker.mjs',
  'scripts/lib/rebase-drop-manifest.mjs', 'scripts/lib/settings-files.mjs', 'scripts/lib/review-label-provider.mjs',
  'scripts/backlog/id.mjs', 'scripts/lib/review-seat-settings.mjs',
  // PR #6381 self-review: the imports of review-set-label, jury-core, the ledgers, record-verdict and review-escalation.
  // review-seat-policy and referral-card-readable decide whether a mandatory referral counts as cleared.
  'scripts/operations/review-seat-policy.mjs', 'scripts/lib/referral-card-readable.mjs', 'scripts/lib/referral-live-context.mjs',
  'scripts/lib/review-labels.mjs', 'scripts/lib/reasonless-bounce.mjs', 'scripts/lib/red-team-status-label-meta.mjs',
  'scripts/lib/red-team-status-labels.mjs', 'scripts/lib/human-review-surfaces.mjs', 'scripts/lib/direction-aware-human.mjs',
  'scripts/lib/false-finding-causes.mjs', 'scripts/lib/mandate-fence.mjs', 'scripts/lib/fixer-escalation-policy.mjs',
  'scripts/lib/operator-send-backs.mjs', 'scripts/lib/restack-equivalence.mjs', 'scripts/lib/fix-handoff.mjs',
  'scripts/lib/main-staleness.mjs', 'scripts/lib/pr-liveness.mjs', 'scripts/lib/prevention-landing-job.mjs',
  'scripts/lib/advisory-labels.mjs', 'scripts/lib/codex-judge-spawn.mjs', 'scripts/lib/judge-spawn.mjs',
  'scripts/lib/constellation-repos.mjs', 'scripts/lib/repo-slug.mjs', 'scripts/lib/repo-profile.mjs', 'scripts/lib/daemon-events.mjs',
  'scripts/lib/gh-throttle.mjs', 'scripts/lib/git-transport-branch.mjs', 'scripts/lib/proc-read.mjs', 'scripts/lib/transient-paths.mjs',
  'scripts/lib/under-test.mjs', 'scripts/lib/write-all-sync.mjs', 'scripts/conveyor/rearm-review.mjs',
  'scripts/conveyor/review-referral-hold.mjs', 'scripts/conveyor/standing-ruling-io.mjs', 'scripts/conveyor/run-scorecard-store.mjs',
  'scripts/conveyor/log-delegation-trial.mjs', 'scripts/conveyor/pr-comments-complete.mjs', 'scripts/conveyor/learnings-drop.mjs',
  'scripts/operations/registry.mjs', 'scripts/operations/step-kinds.mjs', 'scripts/operations/run-store.mjs',
  'scripts/operations/coordination-root.mjs',
  // record-referral-ruling.mjs builds the ruling card's locus prefix through this module (PR #6754).
  'scripts/lib/locus-prefix-text.mjs',
  // The -io and -cli halves' imports: the seat provider and review settings they decide with, and the operation engine.
  // record-verdict-io now resolves the review coordinator through aiRouting before reconstructing the review seats.
  'scripts/lib/ai-routing.mjs',
  'scripts/lib/review-seat-provider.mjs', 'scripts/lib/review-settings.mjs', 'scripts/lib/pr-state/referrals.mjs',
  'scripts/lib/pr-state/snapshot.mjs', 'scripts/lib/gh-app-shim.mjs', 'scripts/apply-review-request.mjs',
  'scripts/operations/review-pr.mjs', 'scripts/operations/review-pr-io.mjs', 'scripts/operations/engine.mjs',
  'scripts/operations/effect-executor.mjs', 'scripts/operations/cli-adapter.mjs', 'scripts/operations/run.mjs',
  // The imports of the ruling modules added in the PR #6381 self-review.
  'scripts/operations/action-record.mjs', 'scripts/operations/action-store.mjs', 'scripts/lib/red-team-disposition.mjs',
  'scripts/lib/review-loop-policy.mjs', 'scripts/operations/land-prevention-card.mjs', 'scripts/operations/card-batch-io.mjs',
  'scripts/operations/detached-dispatch.mjs', 'scripts/operations/call-log-store.mjs', 'scripts/conveyor/stand-down-answer-core.mjs',
  'scripts/conveyor/stand-down.mjs',
  // Added on main after the list above: the finding-class policy and the care-exempt path list decide which findings
  // defer or need a fix, and jury-core.mjs / review-escalation.mjs import them directly.
  'scripts/lib/finding-class-policy.mjs', 'scripts/lib/review-care-exempt-paths.mjs',
  // Also added on main since: direct imports of the family (the card dedupe and the citation check).
  'scripts/lib/card-dedupe.mjs', 'scripts/lib/citation-check.mjs',
  'scripts/lib/human-clearance-mechanical-carry-setting.mjs']);
/**
 * JSON files the floor modules decide with (PR #6381 self-review: red-team.json was read by red-team-gate.mjs but
 * unprotected). A test reads every floor module and pins each tracked scripts/ JSON file whose NAME it quotes, in any
 * form (`'settings/x.json'`, `join(dir, 'settings', 'x.json')`, a file next to the module), onto the floor.
 */
const FLOOR_SETTINGS = Object.freeze([
  // The invariant enforcer catalogue is also named by the protected POC registry module.
  'scripts/lib/invariant-catalogue.json',
  'scripts/settings/build-priority-scope.json',
  'scripts/settings/daemon-tasks.json',
  'scripts/settings/card-ledger-legacy-identities.json', 'scripts/settings/card-ledger-trust.json', 'scripts/settings/card-numbering.json',
  'scripts/settings/red-team.json', 'scripts/settings/github-auth.json', 'scripts/settings/human-review-surfaces.json',
  'scripts/settings/direction-aware-human.json', 'scripts/settings/review-no-verdict-retry.json', 'scripts/settings/referral-hold-auto-resolve.json',
  'scripts/settings/gh-throttle.json', 'scripts/settings/red-main-hold.json', 'scripts/settings/prototype-load.json',
  // The runtime build-priority writer (a floor module) validates its install against this list.
  'scripts/settings/build-priority.json',
  // The legacy dispatch settings file as a glob: this module never reads it, and settings-files.test.mjs counts a quoted
  // literal of its full name as a direct reader.
  'scripts/settings/stand-down.json', 'scripts/settings/fix.json', 'scripts/review-settings.json', 'scripts/dispatch-settings.*',
  // The advisory-merge floor module names it as a regeneration input of the settings registry doc.
  // Legacy generated metadata is not committed (npm run settings:registry); authoring fragments remain protected.
  'scripts/lib/settings-registry-metadata.json', 'scripts/lib/settings-registry-metadata.d/**/*.json',
  'scripts/lib/delivery-platform-preferences.json', 'scripts/lib/delivery-priority-settings.json', 'scripts/lib/poc-branches.json',
  'scripts/exec-output-baseline.json', 'scripts/pr-comment-read-baseline.json', 'scripts/check-standards.contract.json',
  'scripts/lib/dispatch-routing-policy.json', 'scripts/ci/test-timings.json', 'scripts/lib/model-probation.json', 'scripts/lib/swept-repos.json',
  // Read by the lock users added in the PR #6381 red team (the rebuild job and the coroner jobs).
  'scripts/lib/daemon-rebuild-settings.json', 'scripts/settings/coroner.json', 'scripts/settings/coroner-postmortem.json',
  'scripts/lib/dispatch-size-policy.json', 'scripts/lib/dispatch-supervision-promotions.json', 'scripts/lib/review-fix-policy-settings.json',
  'scripts/settings/delivery-metrics.json', 'scripts/settings/needs-you-feed.json', 'scripts/settings/pr-land-ready.json',
  'scripts/settings/pr-limit.json', 'scripts/settings/pr-stall-sweep.json', 'scripts/settings/review-concurrency.json',
  'scripts/settings/review-red-team-on-skip.json',
  // Decides which red-main timeouts the safety net quarantines at once (quarantine-early slice 2).
  'scripts/settings/test-timeout-policy.json',
  // Standalone selector documents named by settings-files.mjs, a protected settings reader.
  'scripts/settings/delivery-strategy.json', 'scripts/settings/delivery-strategy-table.json',
  // Read by hold-scan holders (archive-retention.mjs, scheduled-sweep.mjs).
  'scripts/settings/archive-retention.json', 'scripts/quiet-hours-settings.json',
  // The policy watcher uses these expectations while holding its state lock.
  'scripts/settings/actions-policy-watch.json',
  // Read by card-dedupe.mjs and citation-check.mjs.
  'scripts/settings/card-dedupe.json', 'scripts/conveyor/flows/build-dispatch.flow.json',
  // Read by card-number-ledger.mjs (landed on main since).
  'scripts/settings/card-ledger-legacy-identities.json', 'scripts/settings/card-ledger-trust.json', 'scripts/settings/card-numbering.json',
  // Read by a floor module (landed on main since).
  'scripts/settings/daemon-tasks.json',
  // Read by the fix dispatch daemon, a lock user (landed on main since).
  'scripts/settings/fix-pass-budget.json',
  // Read by the live-owner watch IO, a lock user (landed on main since).
  'scripts/conveyor/pr-live-owner-watch.settings.json']);
/**
 * The lock primitives: the modules that take an exclusive hold (file-locks.mjs reserves a lock entry, with-lock.mjs
 * wraps it, coordination-lock.mjs takes the coordination lease). Any import of one makes a module a lock user (PR #6381
 * red team: fix-claim-store.mjs builds the fix dispatch claim's lock key, but its name holds no floor word).
 */
export const LOCK_PRIMITIVES = Object.freeze(['scripts/readiness/file-locks.mjs', 'scripts/readiness/with-lock.mjs',
  'scripts/operations/coordination-lock.mjs']);
/**
 * Modules that take an exclusive hold of their own (an exclusive `'wx'` create, a lock directory, a reservation or slot
 * file) besides other work, so only an import of their lock API by name (LOCK_API) makes a module a lock user
 * (PR #6381 self-review: atomic-json-file.mjs#withFileLock and the inline holds were missed). An inline hold has no
 * import to scan for, so each is named here.
 * The list is held to a RULE, not kept by hand (PR #6381 judge, R10): a source-scan test (audit-verdict.test.mjs, "the
 * hold scan") finds every tracked module whose code takes an exclusive hold (a `'wx'` / `O_EXCL` / `link` create, a lock
 * directory made without `recursive` beside an `EEXIST` check, or a `.lock` / `.lease` / `.mutex` file name) and fails
 * unless each one is on the floor, by a name glob or by an entry here. The entries after the first block are the
 * modules that scan found unprotected.
 */
export const LOCK_HOLDERS = Object.freeze(['scripts/lib/atomic-json-file.mjs', 'scripts/operations/review-extra-seats.mjs',
  // The policy watcher serializes dedupe state updates with an exclusive lock directory.
  'scripts/conveyor/actions-policy-watch.mjs',
  // The record-only file-class writer reserves its evaluation output with an exclusive `wx` create.
  'scripts/lib/file-class-policy.mjs',
  // The CI retry allowance is consumed with an exclusive `wx` create.
  'scripts/ci/rerun-failed-once.mjs',
  // Red-team reprobe requests dedupe across gate sources and restarts with an exclusive `wx` create.
  'scripts/lib/red-team-queue-state.mjs',
  'scripts/conveyor/health-file-request.mjs', 'scripts/lib/review-seat-pool.mjs', 'scripts/daemon-overlay.mjs',
  'scripts/lib/daemon-overlays.mjs', 'scripts/lib/lane-repair.mjs', 'scripts/lib/overlay-adoption.mjs', 'scripts/lib/we-scan-cache.mjs',
  'scripts/readiness/forge-exec-run.mjs', 'scripts/lib/review-shadow-budget.mjs', 'scripts/readiness/reservations.mjs',
  'scripts/readiness/prepare-hold-state.mjs',
  // Capacity events dedupe across dispatchers with an exclusive-create receipt.
  'scripts/lib/provider-capacity-io.mjs',
  // Binary maintenance serializes scheduled ticks with an exclusive lock directory.
  'scripts/operations/agy-upgrade-check.mjs',
  // The urgent-load verifier takes an exclusive lock directory and `wx` receipt files (found by the hold scan).
  'scripts/operations/urgent-verify.mjs',
  // Receipt archiving reserves its temp with `wx` and publishes with a no-clobber hard link.
  'scripts/readiness/forge-receipts-archive.mjs',
  // Forge deploy reserves record temps with `wx` and serializes writers on a flock deploy lock.
  'scripts/readiness/forge-deploy.mjs',
  // Found by the hold scan (ci-queue-watch.mjs#withHistoryLock and its finalizer among them).
  'scripts/broadcast-inject.mjs', 'scripts/ci/refresh-timings.mjs', 'scripts/conveyor/ci-queue-watch.mjs',
  'scripts/conveyor/ci-red-recovery-watch.mjs', 'scripts/conveyor/health-watch-job.mjs', 'scripts/conveyor/infra-blocked.mjs',
  'scripts/conveyor/open-pr-snapshot.mjs', 'scripts/conveyor/pr-sweep-job.mjs', 'scripts/conveyor/queue-store.mjs',
  'scripts/conveyor/referral-reverify.mjs', 'scripts/conveyor/soak/breaks/fresh-stamp-commit-graph-repair.mjs',
  'scripts/conveyor/unsupported-repo.mjs', 'scripts/conveyor/verified-push-salvage.mjs', 'scripts/lib/archive-retention.mjs',
  'scripts/lib/daemon-boot-smoke.mjs', 'scripts/lib/daemon-rebuild/prepare.mjs', 'scripts/lib/daemon-rebuild/wrong-branch-heal.mjs',
  'scripts/lib/daemon-version-migrate.mjs', 'scripts/lib/daemon-version-runtime.mjs', 'scripts/lib/daemon-version-switch.mjs',
  'scripts/lib/daemon-version.mjs', 'scripts/lib/delivery-policy.mjs', 'scripts/lib/enqueue-on-event.mjs',
  'scripts/lib/finished-ci-cache.mjs', 'scripts/lib/free-lane-list.mjs', 'scripts/lib/lane-alternates.mjs',
  'scripts/lib/lane-card-salvage.mjs', 'scripts/lib/pr-facts.mjs', 'scripts/lib/review-scratch.mjs', 'scripts/lib/runs-writer-exclusion.mjs',
  'scripts/operations/card-batch-extract.mjs', 'scripts/operations/codex-worker.mjs', 'scripts/operations/coroner-extract.mjs',
  'scripts/operations/fix-run.mjs', 'scripts/operations/operator-notify-io.mjs', 'scripts/operations/perf-snapshot-io.mjs',
  'scripts/operations/scheduled-sweep.mjs', 'scripts/readiness/already-done-refresh.mjs', 'scripts/readiness/forge-exec-bases.mjs',
  'scripts/readiness/forge-exec-limits.mjs', 'scripts/readiness/forge-warm-base.mjs', 'scripts/readiness/red-main-remediation.mjs',
  'scripts/readiness/remote-exec.mjs',
  // A no-clobber `link` create (fails with EEXIST) is an exclusive create too (PR #6381 self-review).
  'scripts/conveyor/health-responder-state.mjs',
  // Landed on main since: the lane dependency installer (a no-clobber link create).
  'scripts/lib/lane-deps-installer.mjs',
  // The ruled-weakened waiver store: a locked append/prune/rewrite (an exclusive create).
  'scripts/operations/ruled-weakened-store.mjs',
  // Landed on main since: the fetch-only mirror sync (an exclusive create, a lock directory and a lock file name).
  'scripts/lib/mirror-sync.mjs',
  // Landed on main since: the red-main quarantine rerun marker (an exclusive `wx` create).
  'scripts/lib/red-main-quarantine-io.mjs',
  // Landed on main since: the force-adopt watch transition (a lock directory made without `recursive`).
  'scripts/lib/daemon-force-adopt.mjs',
  // Landed on main since (PR #6381 judge sweep, CI run 42533429518): the review-run archiver and the abandoned-run
  // marker (exclusive `wx` creates), the dead review-run reaper and the borrowed-or-busy clone-maintenance soak break
  // (lock file names).
  'scripts/conveyor/soak/breaks/clone-object-maintenance-borrowed-or-busy.mjs', 'scripts/lib/archive-closed-review-runs.mjs',
  'scripts/lib/reap-dead-review-runs.mjs', 'scripts/lib/run-abandoned.mjs',
  // Landed on main since: the daemon world capsule writer (an exclusive `wx` create).
  'scripts/lib/daemon-rebuild/world-capsule.mjs',
  // Landed on main since: the daemons page renderer (an exclusive create).
  'scripts/operations/daemons-render-io.mjs',
  // Landed on main since (PR #6381, CI run 42791408190): the held-card filer (an exclusive create and a lock file name).
  'scripts/operations/file-held-cards.mjs',
  // Landed on main since: the judge kill-switch store (an exclusive `wx` create).
  'scripts/lib/judge-switches.mjs',
  // Landed on main since (PR #6381, CI run 43334197514): the lock-waiter busy-spin soak break (a lock file name), the
  // review head index (an exclusive create) and the fix-ready record (an exclusive create and a lock file name).
  'scripts/conveyor/soak/breaks/infra-lock-waiter-busy-spins.mjs', 'scripts/lib/review-head-index.mjs',
  'scripts/operations/fix-ready-record.mjs',
  // The urgent-verify receipt writer (an exclusive create and a lock directory).
  'scripts/operations/urgent-verify.mjs',
  // Ghost recovery owns an operation lock as well as reserving the shared rerun budget.
  'scripts/operations/ci-ghost-rerun.mjs',
  // The expectation babysitter serializes state updates and miss delivery with an exclusive lock directory.
  'scripts/conveyor/pass-daemons/pr-expectation-pass.mjs',
  // The stuck-PR detector reads claim locks and serializes NEW-cause receipts with a lock directory.
  'scripts/conveyor/stuck-prs.mjs',
  // The ETag eviction stamp writer uses an exclusive `wx` create.
  'scripts/lib/gh-rest-read.mjs',
  // The runtime build-priority writer serializes installs with an exclusive `wx` lock file.
  'scripts/operations/build-priority-set-io.mjs',
  // The freeze last-good cache writer reserves its temp file with an exclusive `wx` create before the rename.
  'scripts/lib/freeze-last-good.mjs']);
/** The imported names that take, renew or give up a hold (`withFileLock`, `withAddGuardLock`, `acquireFixDispatchClaim`,
 *  `tryLease`, …). */
export const LOCK_API = /^(?:reserve|(?:with|acquire|release|refresh|heartbeat|reserve|try)\w*(?:Claim|Lease|Lock|Hold|Slot|Mutex|Reservation)\w*)$/;
/**
 * Every lock user: a tracked module that imports a lock primitive, or imports a holder's or another lock user's
 * LOCK_API by name (so a caller of acquireFixDispatchClaim, two imports from file-locks.mjs, is one too). The
 * source-scan test computes this set to its fixed point and requires it to EQUAL this list, so a new or removed lock
 * user fails the test.
 */
export const LOCK_USERS = Object.freeze([
  // The fast review pass owns both its singleton lease and the ordinary dispatch lease.
  'scripts/lib/review-fast-pass-cli.mjs',
  // Remote discovery imports the remote-exec lock holder for its execution adapter.
  'scripts/readiness/remote-target.mjs',
  'scripts/operations/ruled-weakened-prune.mjs',
  'scripts/lib/mq-failure-ledger.mjs', 'scripts/lib/operator-override-store.mjs', 'scripts/lib/review-run-index.mjs',
  // Callers of a `with…Lock` helper (withAddGuardLock, withDaemonCloneLock, …) and of a lock user's lock API through a
  // destructured dynamic import.
  'scripts/conveyor/health-watch.mjs', 'scripts/conveyor/liveness-sweep.mjs', 'scripts/conveyor/pass-daemons/pr-postmortem-pass.mjs',
  'scripts/conveyor/poc-branch-sync.mjs', 'scripts/conveyor/soak/breaks/postmortem-poison-merge.mjs',
  'scripts/conveyor/soak/breaks/rebuild-coordination-noop-events.mjs', 'scripts/conveyor/soak/breaks/stale-ruling-report-and-rebuild-wait.mjs',
  'scripts/conveyor/stand-down.mjs', 'scripts/drain-followup-job.mjs', 'scripts/lane-git-diet.mjs', 'scripts/lib/card-number-allocator.mjs',
  'scripts/lib/clone-maintenance.mjs', 'scripts/lib/daemon-rebuild/rebuild.mjs', 'scripts/lib/daemon-rebuild/smoke.mjs',
  'scripts/lib/fast-drain-context.mjs', 'scripts/lib/fast-drain-scope.mjs', 'scripts/lib/queue-branch-numbering.mjs', 'scripts/lib/review-red-team-on-skip.mjs',
  'scripts/operations/card-batch-seal-io.mjs', 'scripts/operations/completion-cli.mjs', 'scripts/operations/poc-land.mjs',
  'scripts/operations/review-job-envelope.mjs', 'scripts/operations/worker-wrapper.mjs', 'scripts/pr-land.mjs',
  'scripts/conveyor/auto-round-grant-io.mjs', 'scripts/conveyor/await-verify-loop.mjs',
  'scripts/conveyor/await-verify.mjs', 'scripts/conveyor/build-dispatch-claim.mjs',
  'scripts/conveyor/build-dispatch-hold-router.mjs', 'scripts/conveyor/build-dispatch-orphan-adopt.mjs',
  // The CI-heal child reserves its cycle lock through file-locks.mjs.
  'scripts/conveyor/ci-heal-loop.mjs',
  'scripts/conveyor/fix-claim-store.mjs', 'scripts/conveyor/fix-dispatch-claim.mjs',
  'scripts/conveyor/fix-procedure.mjs', 'scripts/conveyor/fixer-stuck-reclaim.mjs',
  'scripts/conveyor/health-responder.mjs', 'scripts/conveyor/land-overlap-yield.mjs',
  'scripts/conveyor/main-ci-red-io.mjs', 'scripts/conveyor/needs-you-feed-job.mjs',
  'scripts/conveyor/nightly-coroner-job.mjs', 'scripts/conveyor/pr-stall-digest.mjs',
  'scripts/conveyor/pr-stall-sweep.mjs', 'scripts/conveyor/reconcile-fix-dispatch.mjs',
  'scripts/conveyor/resolve-runner-checkout.mjs', 'scripts/conveyor/resource-sampler-daemon.mjs',
  'scripts/conveyor/session-watchdog.mjs', 'scripts/conveyor/soak/breaks/lease-reaper-borrowed-fixer-pid-invisible.mjs',
  'scripts/conveyor/soak/breaks/standdown-pr-holds-scope-slot.mjs', 'scripts/conveyor/stand-down-auto-proceed-io.mjs',
  'scripts/held-cards-io.mjs', 'scripts/lane-drain.mjs', 'scripts/lib/card-group.mjs', 'scripts/lib/card-number-ledger.mjs',
  'scripts/lib/daemon-clone-lock.mjs', 'scripts/lib/daemon-item-tasks.mjs', 'scripts/lib/daemon-jobs-runtime.mjs',
  'scripts/lib/daemon-load-overlay.mjs', 'scripts/lib/daemon-rebuild/adopt.mjs', 'scripts/lib/daemon-rebuild/auto-rebase.mjs',
  'scripts/lib/daemon-rebuild/overlay-main-sync.mjs', 'scripts/lib/daemon-rebuild/rebuild-job.mjs',
  'scripts/lib/drain-queue-safety.mjs', 'scripts/lib/drain-red-team-evidence.mjs', 'scripts/lib/fix-slot-borrow.mjs',
  'scripts/lib/gh-throttle-holders.mjs', 'scripts/lib/gh-throttle.mjs', 'scripts/lib/host-load.mjs',
  'scripts/lib/merge-queue-adaptive-batching.mjs', 'scripts/lib/pr-limit.mjs', 'scripts/lib/pr-list-paged.mjs', 'scripts/lib/pr-snapshot.mjs',
  // Gate refresh takes withFileLock; enqueue reserves the pending-refresh reader lock.
  'scripts/lib/merge-gate-refresh.mjs', 'scripts/lib/merge-queue-enqueue.mjs',
  'scripts/lib/red-team-carry-machine.mjs', 'scripts/lib/red-team-withheld-publish.mjs',
  // PR #6606: the one host-local red-team check lock (withRedTeamCheckLock over atomic-json-file#withFileLock).
  'scripts/lib/red-team-check-run.mjs',
  'scripts/lib/required-status-checks.mjs', 'scripts/lib/resource-admission.mjs', 'scripts/lib/salvage-index.mjs',
  // Read-only inventory imports the file-lock primitive to validate observed claims and slots.
  'scripts/lib/resource-pool-io.mjs',
  'scripts/lib/scheduled-lane-maintenance.mjs', 'scripts/lib/target-registry.mjs',
  'scripts/lib/verdict-ledger-outbox-spool.mjs', 'scripts/lib/verdict-ledger.mjs', 'scripts/lib/verify-shard-run.mjs',
  'scripts/merge-ai-prs.mjs', 'scripts/operations/action-ground-truth.mjs', 'scripts/operations/action-store.mjs',
  'scripts/operations/ci-heal-pr-dispatch.mjs', 'scripts/operations/cli-adapter.mjs',
  'scripts/operations/completion-store.mjs', 'scripts/operations/coroner-pr-postmortem.mjs',
  'scripts/operations/daemon-status-io.mjs', 'scripts/operations/deliver-item-wrapper.mjs',
  'scripts/operations/delivery-metrics.mjs', 'scripts/operations/dispatch-lane-io.mjs',
  'scripts/operations/free-scope-io.mjs', 'scripts/operations/land-advance-gate.mjs',
  'scripts/operations/needs-you-feed.mjs', 'scripts/operations/operator-controls-io.mjs',
  'scripts/operations/prepare-stamp-land.mjs', 'scripts/operations/probation-build-run.mjs',
  'scripts/operations/probation-heal-run.mjs', 'scripts/operations/restart-runner-io.mjs',
  'scripts/operations/routing-override-file.mjs', 'scripts/operations/runner-activity-io.mjs',
  'scripts/operations/start-build.mjs', 'scripts/operations/tick-mutex.mjs', 'scripts/operations/tick-throttle.mjs',
  'scripts/operations/worker-result-router.mjs', 'scripts/readiness/drain-lock.mjs',
  'scripts/readiness/file-locks-cli.mjs', 'scripts/readiness/forge-remote-health.mjs',
  'scripts/readiness/forge-slot-markers.mjs', 'scripts/readiness/heavy-admission.mjs', 'scripts/review-runner.mjs',
  'scripts/verify-lane.mjs', 'skills-src/conveyor/build-dispatch-daemon.mjs', 'skills-src/conveyor/pass-daemon.mjs',
  'skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs', 'skills-src/conveyor/review-daemon.mjs',
  'skills-src/conveyor/runner-lock.mjs', 'skills-src/conveyor/runner.mjs', 'skills-src/conveyor/supervisor-launcher.mjs',
  'skills-src/conveyor/verify-daemon.mjs',
  // Callers of a hold-scan holder's lock API (PR #6381 judge).
  'scripts/conveyor/backfill-changed-files.mjs', 'scripts/conveyor/run-scorecard-store.mjs',
  'scripts/conveyor/soak/breaks/daemon-entry-boot-crash.mjs', 'scripts/conveyor/soak/breaks/exhausted-retry-recovery.mjs',
  'scripts/lib/drain-facts-source.mjs', 'scripts/lib/merge-queue-hook.mjs', 'scripts/lib/pr-size-admission.mjs',
  'scripts/lib/renamed-pr-refresh.mjs', 'scripts/operations/operator-notify-cli.mjs',
  // Landed on main since: the daemon self-sync lock user.
  'scripts/lib/daemon-self-sync.mjs',
  // Landed on main since: the PR stall reset (takes withFileLock from atomic-json-file.mjs).
  'scripts/conveyor/pr-stall-reset.mjs',
  // Landed on main since (PR #6381, CI run 43334197514): the live-owner watch IO. The review head index is a hold-scan
  // holder (LOCK_HOLDERS) and so a seed of the scan, never a lock user.
  'scripts/conveyor/pr-live-owner-watch-io.mjs',
  // The timeout-evidence pool probes the throttle with acquireGhSlotSync/releaseGhSlotSync.
  'scripts/conveyor/timeout-evidence-pool.mjs',
  // The shared stuck-trace queue serializes enqueue, claims and completion through withFileLock.
  'scripts/conveyor/stuck-trace.mjs']);
// The concurrency words match ANYWHERE in the basename (`forge-slot-markers.mjs`, `lane-worker-without-lease.mjs`), not
// only at its start (PR #6381 send-back). `**/` needs at least one folder, so each entry has a twin for scripts/ itself.
// This also protects names holding the word inside another word (`release` holds `lease`): protecting more only ever
// blocks more, and the audit-verdict test lists that over-capture.
// A Set: the lock users repeat a few modules other entries already name.
export const GUARD_FLOOR = Object.freeze([...new Set(['scripts/**/*file-locks*', 'scripts/*file-locks*', 'scripts/**/*lease*', 'scripts/*lease*',
  'scripts/lib/poc-branches.mjs', 'scripts/lib/prototype-tracker-data.mjs',
  'scripts/lib/local-date.mjs', 'scripts/lib/constellation-repos.mjs',
  'scripts/lib/authorized-push.mjs', 'scripts/lib/review-hold-model.mjs', 'scripts/lib/strict-utc-timestamp.mjs',
  'scripts/lib/lane-lease.mjs', 'scripts/readiness/scope-lease*',
  'scripts/**/*slot*', 'scripts/*slot*', 'scripts/**/*lock-reaper*', 'scripts/*lock-reaper*', 'scripts/**/*lane-pool*', 'scripts/*lane-pool*',
  'scripts/**/*merge*', 'scripts/*merge*', 'scripts/**/*drain*', 'scripts/*drain*', 'scripts/**/*mq*', 'scripts/*mq*',
  // Claims and mutexes are locks too (PR #6381 red team: the fix dispatch claim store).
  'scripts/**/*claim*', 'scripts/*claim*', 'scripts/**/*mutex*', 'scripts/*mutex*', ...LOCK_PRIMITIVES, ...LOCK_HOLDERS, ...LOCK_USERS,
  'scripts/operations/daemons-render-io.mjs', 'scripts/readiness/forge-cache-prune.mjs',
  // Hold-scan modules the source-scan floor test found missing (PR #6381 judge).
  'scripts/conveyor/soak/breaks/clone-object-maintenance-borrowed-or-busy.mjs', 'scripts/lib/archive-closed-review-runs.mjs',
  'scripts/lib/reap-dead-review-runs.mjs', 'scripts/lib/run-abandoned.mjs', 'scripts/lib/build-queue-cache.mjs',
  // The acquire-scan-contention break names the scan lock file (`.list-acquirable.lock`) it holds open.
  'scripts/conveyor/soak/breaks/lane-acquire-waiter-takes-partial.mjs',
  // The missing-run push reservation is an exclusive-create (`wx`) hold: a race in it double-pushes a recovery.
  'scripts/conveyor/missing-run-push.mjs',
  // Shared verification greens use exclusive creation and a no-clobber hard link for write-once publication.
  'scripts/lib/verify-shared-marker.mjs',
  // The AGY usage reader writes its record through an exclusive-create (`wx`) temp file before the rename.
  'scripts/operations/agy-usage-reader.mjs',
  'scripts/*-lock.mjs', 'scripts/**/*-lock.mjs', 'scripts/**/with-lock*', 'skills-src/**/*-lock.mjs',
  'scripts/guard-*', 'scripts/**/guard-*', 'scripts/*-guard*', 'scripts/**/*-guard*', 'scripts/guarded-*', 'scripts/**/guarded-*',
  '.claude/settings.json', '.githooks/', 'scripts/lib/git-hook-surface.mjs', 'scripts/lib/permission-change.mjs',
  'scripts/lib/pr-merge-gate.mjs', '.github/workflows/',
  // Required-check, review and merge authorization gates (PR #6381 judge: scripts/lib/review-ci-gate.mjs was missing).
  'scripts/lib/review-ci-gate*', 'scripts/*-gate*', 'scripts/**/*-gate*', 'scripts/lib/gate-*', 'scripts/lib/required-check*',
  'scripts/lib/operator-override-reader.mjs', 'scripts/lib/promotion-required-checks.mjs', 'scripts/rulesets/', 'scripts/settings/required-checks-cache.json',
  // Modules those gates decide with (their imports): weakening one weakens the gate.
  'scripts/lib/required-status-checks.mjs', 'scripts/lib/rollup-collapse.mjs',
  'scripts/lib/review-timing.mjs', 'scripts/lib/review-policy*', 'scripts/lib/github-auth-policy.mjs', 'scripts/operations/gate-health*',
  // Review authorization and the modules it imports directly (see REVIEW_AUTH_FLOOR).
  ...REVIEW_AUTH_FLOOR, ...REVIEW_AUTH_IMPORTS, ...FLOOR_SETTINGS,
  // The review settings file: carryAcrossRebase and unattendedAcceptRequiresCleanReferrals decide carries and accepts.
  'scripts/settings/review.json',
  // The auditor itself and the modules it imports directly (see AUDITOR_FLOOR).
  ...AUDITOR_FLOOR, ...AUDITOR_IMPORTS])]);
