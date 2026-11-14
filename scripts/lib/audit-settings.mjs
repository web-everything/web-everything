/**
 * Audit rubric settings (R528, AU1 PR-A). Pure resolution of named decisions through the shared policy cascade.
 * Trusted source only: the file is read from the RUNNING checkout (derived from this module's location), never
 * from a candidate diff or the cwd. Env may only TIGHTEN; any unreadable or invalid value resolves to the
 * strictest option. Inert: nothing in the runtime imports this yet (PR-C wires it).
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { assertProtectedPatterns } from './audit-path.mjs';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { cascadePolicy, LEGACY_PLATFORM_PREFERENCES_PATHS, operatorPreferencesPath, PLATFORM_PREFERENCES_ENV, PLATFORM_PREFERENCES_PATH,
  readPlatformPreferences } from './policy-cascade.mjs';

export const AUDIT_SETTINGS_PATH = fileURLToPath(new NodeURL('../settings/codex-audit.json', import.meta.url));
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
export const AUDITOR_FLOOR = Object.freeze(['scripts/operations/audit-verdict.mjs', 'scripts/operations/codex-audit*',
  'scripts/lib/audit-settings.mjs', 'scripts/lib/audit-path.mjs', 'scripts/lib/policy-cascade.mjs', 'scripts/settings/codex-audit.json',
  'scripts/codex-direct-task.mjs']);
/** Modules the auditor imports or launches directly that no other floor entry names (the source-scan test pins each). */
const AUDITOR_IMPORTS = Object.freeze(['scripts/lib/net-diff-fingerprint.mjs', 'scripts/lib/under-test.mjs',
  // The audit launcher's imports, and the transcript-check settings its policy reads.
  'scripts/lib/codex-transcript-policy.mjs', 'scripts/lib/codex-transcript-check.mjs', 'scripts/settings/codex-transcript-check.json',
  'scripts/lib/build-policy.mjs', 'scripts/lib/build-self-review.mjs', 'scripts/lib/lane-git-hardening.mjs',
  'scripts/lib/codex-usage-ledger.mjs', 'scripts/lib/codex-model-routing.mjs', 'scripts/lib/codex-task-route.mjs']);
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
  // The -io and -cli halves' imports: the seat provider and review settings they decide with, and the operation engine.
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
  'scripts/settings/daemon-tasks.json',
  'scripts/settings/card-ledger-legacy-identities.json', 'scripts/settings/card-ledger-trust.json', 'scripts/settings/card-numbering.json',
  'scripts/settings/red-team.json', 'scripts/settings/github-auth.json', 'scripts/settings/human-review-surfaces.json',
  'scripts/settings/direction-aware-human.json', 'scripts/settings/review-no-verdict-retry.json', 'scripts/settings/referral-hold-auto-resolve.json',
  'scripts/settings/gh-throttle.json', 'scripts/settings/red-main-hold.json', 'scripts/settings/prototype-load.json',
  // The legacy dispatch settings file as a glob: this module never reads it, and settings-files.test.mjs counts a quoted
  // literal of its full name as a direct reader.
  'scripts/settings/stand-down.json', 'scripts/settings/fix.json', 'scripts/review-settings.json', 'scripts/dispatch-settings.*',
  'scripts/lib/delivery-platform-preferences.json', 'scripts/lib/delivery-priority-settings.json', 'scripts/lib/poc-branches.json',
  'scripts/exec-output-baseline.json', 'scripts/pr-comment-read-baseline.json', 'scripts/check-standards.contract.json',
  'scripts/lib/dispatch-routing-policy.json', 'scripts/ci/test-timings.json', 'scripts/lib/model-probation.json', 'scripts/lib/swept-repos.json',
  // Read by the lock users added in the PR #6381 red team (the rebuild job and the coroner jobs).
  'scripts/lib/daemon-rebuild-settings.json', 'scripts/settings/coroner.json', 'scripts/settings/coroner-postmortem.json',
  'scripts/lib/dispatch-size-policy.json', 'scripts/lib/dispatch-supervision-promotions.json', 'scripts/lib/review-fix-policy-settings.json',
  'scripts/settings/delivery-metrics.json', 'scripts/settings/needs-you-feed.json', 'scripts/settings/pr-land-ready.json',
  'scripts/settings/pr-limit.json', 'scripts/settings/pr-stall-sweep.json', 'scripts/settings/review-concurrency.json',
  'scripts/settings/review-red-team-on-skip.json',
  // Read by hold-scan holders (archive-retention.mjs, scheduled-sweep.mjs).
  'scripts/settings/archive-retention.json', 'scripts/quiet-hours-settings.json',
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
  'scripts/conveyor/health-file-request.mjs', 'scripts/lib/review-seat-pool.mjs', 'scripts/daemon-overlay.mjs',
  'scripts/lib/daemon-overlays.mjs', 'scripts/lib/lane-repair.mjs', 'scripts/lib/overlay-adoption.mjs', 'scripts/lib/we-scan-cache.mjs',
  'scripts/readiness/forge-exec-run.mjs', 'scripts/lib/review-shadow-budget.mjs', 'scripts/readiness/reservations.mjs',
  'scripts/readiness/prepare-hold-state.mjs',
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
  'scripts/operations/fix-ready-record.mjs']);
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
  'scripts/lib/mq-failure-ledger.mjs',
  // Callers of a `with…Lock` helper (withAddGuardLock, withDaemonCloneLock, …) and of a lock user's lock API through a
  // destructured dynamic import.
  'scripts/conveyor/health-watch.mjs', 'scripts/conveyor/liveness-sweep.mjs', 'scripts/conveyor/pass-daemons/pr-postmortem-pass.mjs',
  'scripts/conveyor/poc-branch-sync.mjs', 'scripts/conveyor/soak/breaks/postmortem-poison-merge.mjs',
  'scripts/conveyor/soak/breaks/rebuild-coordination-noop-events.mjs', 'scripts/conveyor/soak/breaks/stale-ruling-report-and-rebuild-wait.mjs',
  'scripts/conveyor/stand-down.mjs', 'scripts/drain-followup-job.mjs', 'scripts/lane-git-diet.mjs', 'scripts/lib/card-number-allocator.mjs',
  'scripts/lib/clone-maintenance.mjs', 'scripts/lib/daemon-rebuild/rebuild.mjs', 'scripts/lib/daemon-rebuild/smoke.mjs',
  'scripts/lib/fast-drain-scope.mjs', 'scripts/lib/queue-branch-numbering.mjs', 'scripts/lib/review-red-team-on-skip.mjs',
  'scripts/operations/card-batch-seal-io.mjs', 'scripts/operations/completion-cli.mjs', 'scripts/operations/poc-land.mjs',
  'scripts/operations/review-job-envelope.mjs', 'scripts/operations/worker-wrapper.mjs', 'scripts/pr-land.mjs',
  'scripts/conveyor/auto-round-grant-io.mjs', 'scripts/conveyor/await-verify-loop.mjs',
  'scripts/conveyor/await-verify.mjs', 'scripts/conveyor/build-dispatch-claim.mjs',
  'scripts/conveyor/build-dispatch-hold-router.mjs', 'scripts/conveyor/build-dispatch-orphan-adopt.mjs',
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
  'scripts/lib/daemon-load-overlay.mjs', 'scripts/lib/daemon-rebuild/auto-rebase.mjs',
  'scripts/lib/daemon-rebuild/overlay-main-sync.mjs', 'scripts/lib/daemon-rebuild/rebuild-job.mjs',
  'scripts/lib/drain-queue-safety.mjs', 'scripts/lib/drain-red-team-evidence.mjs', 'scripts/lib/fix-slot-borrow.mjs',
  'scripts/lib/gh-throttle-holders.mjs', 'scripts/lib/gh-throttle.mjs', 'scripts/lib/host-load.mjs',
  'scripts/lib/merge-queue-adaptive-batching.mjs', 'scripts/lib/pr-limit.mjs', 'scripts/lib/pr-snapshot.mjs',
  'scripts/lib/red-team-carry-machine.mjs', 'scripts/lib/red-team-withheld-publish.mjs',
  'scripts/lib/required-status-checks.mjs', 'scripts/lib/resource-admission.mjs', 'scripts/lib/salvage-index.mjs',
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
  'scripts/conveyor/pr-live-owner-watch-io.mjs']);
// The concurrency words match ANYWHERE in the basename (`forge-slot-markers.mjs`, `lane-worker-without-lease.mjs`), not
// only at its start (PR #6381 send-back). `**/` needs at least one folder, so each entry has a twin for scripts/ itself.
// This also protects names holding the word inside another word (`release` holds `lease`): protecting more only ever
// blocks more, and the audit-verdict test lists that over-capture.
// A Set: the lock users repeat a few modules other entries already name.
export const GUARD_FLOOR = Object.freeze([...new Set(['scripts/**/*file-locks*', 'scripts/*file-locks*', 'scripts/**/*lease*', 'scripts/*lease*',
  'scripts/lib/lane-lease.mjs', 'scripts/readiness/scope-lease*',
  'scripts/**/*slot*', 'scripts/*slot*', 'scripts/**/*lock-reaper*', 'scripts/*lock-reaper*', 'scripts/**/*lane-pool*', 'scripts/*lane-pool*',
  'scripts/**/*merge*', 'scripts/*merge*', 'scripts/**/*drain*', 'scripts/*drain*', 'scripts/**/*mq*', 'scripts/*mq*',
  // Claims and mutexes are locks too (PR #6381 red team: the fix dispatch claim store).
  'scripts/**/*claim*', 'scripts/*claim*', 'scripts/**/*mutex*', 'scripts/*mutex*', ...LOCK_PRIMITIVES, ...LOCK_HOLDERS, ...LOCK_USERS,
  'scripts/operations/daemons-render-io.mjs', 'scripts/readiness/forge-cache-prune.mjs',
  // Hold-scan modules the source-scan floor test found missing (PR #6381 judge).
  'scripts/conveyor/soak/breaks/clone-object-maintenance-borrowed-or-busy.mjs', 'scripts/lib/archive-closed-review-runs.mjs',
  'scripts/lib/reap-dead-review-runs.mjs', 'scripts/lib/run-abandoned.mjs', 'scripts/lib/build-queue-cache.mjs',
  // The missing-run push reservation is an exclusive-create (`wx`) hold: a race in it double-pushes a recovery.
  'scripts/conveyor/missing-run-push.mjs',
  'scripts/*-lock.mjs', 'scripts/**/*-lock.mjs', 'scripts/**/with-lock*', 'skills-src/**/*-lock.mjs',
  'scripts/guard-*', 'scripts/**/guard-*', 'scripts/*-guard*', 'scripts/**/*-guard*', 'scripts/guarded-*', 'scripts/**/guarded-*',
  '.claude/settings.json', '.githooks/', 'scripts/lib/git-hook-surface.mjs', 'scripts/lib/permission-change.mjs',
  'scripts/lib/pr-merge-gate.mjs', '.github/workflows/',
  // Required-check, review and merge authorization gates (PR #6381 judge: scripts/lib/review-ci-gate.mjs was missing).
  'scripts/lib/review-ci-gate*', 'scripts/*-gate*', 'scripts/**/*-gate*', 'scripts/lib/gate-*', 'scripts/lib/required-check*',
  'scripts/lib/promotion-required-checks.mjs', 'scripts/rulesets/', 'scripts/settings/required-checks-cache.json',
  // Modules those gates decide with (their imports): weakening one weakens the gate.
  'scripts/lib/required-status-checks.mjs', 'scripts/lib/rollup-collapse.mjs',
  'scripts/lib/review-timing.mjs', 'scripts/lib/review-policy*', 'scripts/lib/github-auth-policy.mjs', 'scripts/operations/gate-health*',
  // Review authorization and the modules it imports directly (see REVIEW_AUTH_FLOOR).
  ...REVIEW_AUTH_FLOOR, ...REVIEW_AUTH_IMPORTS, ...FLOOR_SETTINGS,
  // The review settings file: carryAcrossRebase and unattendedAcceptRequiresCleanReferrals decide carries and accepts.
  'scripts/settings/review.json',
  // The auditor itself and the modules it imports directly (see AUDITOR_FLOOR).
  ...AUDITOR_FLOOR, ...AUDITOR_IMPORTS])]);
/** What an invalid or unreadable path list resolves to: the floor plus every path (`**` matches any path). */
const STRICTEST_PATHS = Object.freeze([...GUARD_FLOOR, '**']);

// Ordered strictest first; env may only move toward the front.
const RANKS = Object.freeze({
  verdictMode: ['shadow', 'model', 'computed'],
  preExistingMode: ['block', 'prove', 'allow'],
  releaseStage: ['prod', 'prerelease'],
});
export const AUDIT_SETTINGS_ENV = Object.freeze({
  verdictMode: 'WE_AUDIT_VERDICT_MODE', preExistingMode: 'WE_AUDIT_PREEXISTING_MODE', releaseStage: 'WE_AUDIT_RELEASE_STAGE',
  raceBlockPaths: 'WE_AUDIT_RACE_BLOCK_PATHS', guardFloorPaths: 'WE_AUDIT_GUARD_FLOOR_PATHS',
  recheckMax: 'WE_AUDIT_RECHECK_MAX', baseRecheckMax: 'WE_AUDIT_BASE_RECHECK_MAX',
  requireOnMain: 'WE_AUDIT_CARDS_REQUIRE_ON_MAIN', requirePayBy: 'WE_AUDIT_CARDS_REQUIRE_PAY_BY',
});
const MAX_RECHECK = 3;
const STRICTEST = Object.freeze({ verdictMode: 'shadow', preExistingMode: 'block', releaseStage: 'prod', recheckMax: 0, baseRecheckMax: 0,
  requireOnMain: true, requirePayBy: true });
const DEFAULTS = Object.freeze({ verdictMode: 'model', preExistingMode: 'block', releaseStage: 'prerelease', recheckMax: 1, baseRecheckMax: 3,
  requireOnMain: true, requirePayBy: true });

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
// Preserve strictest recovery for unreadable settings; a well-shaped list with a malformed
// path is a configuration error that must stop the whole load before verdict computation.
class MalformedProtectedPatterns extends Error {}
function assertConfiguredPatterns(patterns) {
  try { assertProtectedPatterns(patterns); }
  catch (cause) { throw new MalformedProtectedPatterns(cause.message, { cause }); }
}
const validPaths = v => Array.isArray(v) && v.length <= 256 && v.every(p => typeof p === 'string' && p.trim().length > 0 && p.length <= 512);
// The same record shape findAudit reads (scripts/operations/codex-audit.mjs resolvePriorQuestionHashes): one
// {hash, acceptUntil} object per prior question hash, the hash 64 lowercase hex characters. Two readers of one
// settings key must agree, so a bare-string list (or any other shape) is invalid here too (PR #6381 merge).
const HASH_64 = /^[a-f0-9]{64}(?![\s\S])/;
// Both fields must be strings BEFORE they reach a parser: `Date.parse` and `RegExp#test` convert their argument to
// text, and a JSON object such as `{"toString":0}` cannot be converted, so it would throw (PR #6381 red team). A
// non-string is invalid, which empties the list.
const validHashes = v => Array.isArray(v) && v.length <= 64
  && v.every(e => isObj(e) && typeof e.hash === 'string' && HASH_64.test(e.hash)
    && typeof e.acceptUntil === 'string' && Number.isFinite(Date.parse(e.acceptUntil)));
const validCount = v => Number.isInteger(v) && v >= 0 && v <= MAX_RECHECK;
const enumOf = key => v => RANKS[key].includes(v);
const VALID = Object.freeze({ verdictMode: enumOf('verdictMode'), preExistingMode: enumOf('preExistingMode'), releaseStage: enumOf('releaseStage'),
  recheckMax: validCount, baseRecheckMax: validCount, requireOnMain: v => typeof v === 'boolean', requirePayBy: v => typeof v === 'boolean' });

function readFile(path, read) {
  try {
    const v = JSON.parse(read(path, 'utf8'));
    return isObj(v) && isObj(v.audit) && auditVariants(v).length === 0 ? { tool: v.audit } : { tool: null, unreadable: true };
  } catch { return { tool: null, unreadable: true }; }
}
/**
 * Top-level keys that are not exactly `audit` but fold to it (`Audit`, `audit` plus a zero-width space, fullwidth
 * letters). The reader only ever reads `audit`, so such a key's settings would be dropped with no warning; the caller
 * treats the section as unreadable instead (PR #6381 judge). Folded like a setting key (`foldKey`).
 */
function auditVariants(obj) {
  return isObj(obj) ? Object.keys(obj).filter(k => k !== 'audit' && foldKey(k) === 'audit') : [];
}
// A key for a warning: JSON-quoted, with every non-printable-ASCII character escaped so an invisible one shows.
const showKey = k => JSON.stringify(k).replace(/[^\x20-\x7e]/gu, c => `\\u${c.codePointAt(0).toString(16).padStart(4, '0')}`);
const SECTION_PATHS = Object.freeze({ __proto__: null, verdictMode: ['verdict', 'mode'], preExistingMode: ['preExisting', 'mode'],
  baseRecheckMax: ['preExisting', 'baseRecheckMax'], recheckMax: ['recheck', 'max'], requireOnMain: ['cards', 'requireOnMain'],
  requirePayBy: ['cards', 'requirePayBy'] });
// A null-prototype map: a polluted Object.prototype can never turn a setting name into an inherited path.
const pathOf = key => SECTION_PATHS[key] ?? [key];
const get = (tool, key) => {
  const [a, b] = pathOf(key);
  return b === undefined ? tool?.[a] : tool?.[a]?.[b];
};
/** A setting's value in one raw layer, own keys only (as the cascade reads a layer); undefined when it is not set. */
const ownGet = (layer, key) => {
  const [a, b] = pathOf(key);
  if (!isObj(layer) || !Object.hasOwn(layer, a)) return undefined;
  if (b === undefined) return layer[a];
  return isObj(layer[a]) && Object.hasOwn(layer[a], b) ? layer[a][b] : undefined;
};
/**
 * Malformed explicit entries the cascade's leaf flattening hides (PR #6381): an empty object at a setting has no
 * leaves, so `releaseStage: {}` vanishes and reads as omitted; a non-object where a section belongs
 * (`verdict: "shadow"`) makes `verdict.mode` read as omitted. Checked on each RAW layer so such an entry fails
 * closed instead of earning the default. An empty section (`verdict: {}`) sets nothing and stays omitted.
 */
function rawMalformed(layer, key, valid) {
  if (!isObj(layer)) return false;
  const [a, b] = pathOf(key);
  if (!Object.hasOwn(layer, a)) return false;
  if (b === undefined) return !valid(layer[a]);
  if (!isObj(layer[a])) return true;
  return Object.hasOwn(layer[a], b) && !valid(layer[a][b]);
}
/**
 * A key that differs from a setting only by letter case, compatibility form, whitespace or an invisible character
 * (`ReleaseStage`, `recheck.Max`, `"releaseStage "`, a zero-width space, fullwidth or long-s letters) is an explicit
 * choice the cascade cannot see: it would read as omitted and earn the default. It fails that setting closed instead.
 * Other misspellings (`verdicts`) cannot be mapped to a setting; they are only named by `unknownKeys`.
 */
// Control (Cc) and format (Cf) characters and braille cells (the blank one is invisible) fold away too (PR #6381
// self-review). Written as property classes: a raw invisible character in source is refused by check:standards.
const foldKey = s => s.normalize('NFKC').replace(/[\s\p{Default_Ignorable_Code_Point}\p{Cc}\p{Cf}\p{Script=Braille}]/gu, '').toLowerCase();
function caseShadowed(layer, key) {
  if (!isObj(layer)) return false;
  const [a, b] = pathOf(key);
  const fold = foldKey;
  for (const [ka, x] of Object.entries(layer)) {
    if (fold(ka) !== fold(a)) continue;
    if (b === undefined) { if (ka !== a) return true; continue; }
    if (!isObj(x)) { if (ka !== a) return true; continue; }
    for (const kb of Object.keys(x)) if (fold(kb) === fold(b) && (ka !== a || kb !== b)) return true;
  }
  return false;
}
const KNOWN = (() => {
  const m = new Map();
  for (const key of [...Object.keys(STRICTEST), 'raceBlockPaths', 'guardFloorPaths', 'priorQuestionHashes']) {
    const [a, b] = pathOf(key);
    if (!m.has(a)) m.set(a, new Set());
    if (b !== undefined) m.get(a).add(b);
  }
  return m;
})();
/** Misspelled keys (`verdicts`, `ReleaseStage`, `recheck.Max`) read as omitted: name them ($-prefixed notes skipped). */
function unknownKeys(layer) {
  if (!isObj(layer)) return [];
  const out = [];
  for (const [a, x] of Object.entries(layer)) {
    if (a.startsWith('$')) continue;
    if (!KNOWN.has(a)) { out.push(a); continue; }
    if (KNOWN.get(a).size && isObj(x)) for (const b of Object.keys(x)) if (!b.startsWith('$') && !KNOWN.get(a).has(b)) out.push(`${a}.${b}`);
  }
  return out;
}
const parseEnv = (key, raw) => {
  if (typeof raw !== 'string') return undefined;
  if (['recheckMax', 'baseRecheckMax'].includes(key)) return /^\d+$/.test(raw) ? Number(raw) : undefined;
  if (['requireOnMain', 'requirePayBy'].includes(key)) return raw === 'true' ? true : raw === 'false' ? false : undefined;
  return raw;
};
// The value a setting takes effect as: preExisting mode allow is never trusted and resolves to block.
const effective = (key, v) => (key === 'preExistingMode' && v === 'allow' ? 'block' : v);
/** Is `candidate` at least as strict as `current`? Compared as they take effect, so allow ranks with block. */
function tighter(key, candidate, current) {
  if (RANKS[key]) return RANKS[key].indexOf(effective(key, candidate)) <= RANKS[key].indexOf(effective(key, current));
  if (key === 'recheckMax' || key === 'baseRecheckMax') return candidate <= current;
  return candidate === true || current === false;
}

/**
 * Under a platform-file override, each single-value setting the default chain sets validly is a floor: the override's
 * value is kept only when it is at least as strict, else the chain's value is used (where the override omits it too).
 * An invalid override value is left in place, so it fails that setting closed as usual.
 */
function tightenToChain(over, chain) {
  const out = structuredClone(over);
  for (const key of Object.keys(DEFAULTS)) {
    const c = get(chain, key);
    if (c === undefined || !VALID[key](c)) continue;
    const o = get(out, key);
    if (o !== undefined && (!VALID[key](o) || tighter(key, o, c))) continue;
    const [a, b] = pathOf(key);
    if (b === undefined) { out[a] = c; continue; }
    if (out[a] === undefined) out[a] = {};
    if (isObj(out[a])) out[a][b] = c;
  }
  return out;
}

/**
 * Resolve the audit settings. `fileRead`/`path`/`platform`/`platformRead` are test seams; production passes none.
 * Malformed protected patterns throw and abort the load. Other resolution failures (a value a parser cannot convert, an environment
 * object that throws on read) resolves EVERY setting to its strictest option, with a warning (PR #6381 red team).
 * @returns {{value: object, sources: Record<string,string>, warnings: string[]}}
 */
export function resolveAuditSettings(options = {}) {
  // Shared with the resolution, so warnings it logged before a throw stay in the returned list (log and list agree).
  const warnings = [];
  try { return resolveUnguarded(options ?? {}, warnings); } catch (err) {
    if (err instanceof MalformedProtectedPatterns) throw err;
    let reason = 'unknown error';
    try { if (typeof err?.message === 'string') reason = err.message.slice(0, 200); } catch { /* keep the generic reason */ }
    const warning = `audit settings could not be resolved (${reason}); every setting resolves to its strictest option`;
    try { (options?.log ?? (() => {}))(warning); } catch { /* never throws */ }
    const value = { ...STRICTEST, raceBlockPaths: STRICTEST_PATHS, guardFloorPaths: STRICTEST_PATHS, priorQuestionHashes: Object.freeze([]) };
    warnings.push(warning);
    return { value: Object.freeze(value), sources: Object.fromEntries(Object.keys(value).map(k => [k, 'strictest'])), warnings };
  }
}
function resolveUnguarded({ path = AUDIT_SETTINGS_PATH, fileRead = readFileSync, platform, platformRead = readFileSync, env = process.env, log } = {}, warnings) {
  const warn = m => { warnings.push(m); try { (log ?? (() => {}))(m); } catch { /* never throws */ } };
  const { tool, unreadable } = readFile(path, fileRead);
  // The platform layer is read HERE, not inside the cascade, so its read errors and an explicit `"audit": null`
  // stay visible: the cascade drops both and they would read as "no platform preference".
  // `chainPlat` is the default platform chain's audit preference, read only when an override replaces that chain:
  // the override may ADD protected paths, never remove the chain's (PR #6381 judge).
  // `chainFiles` is each default-chain file's own audit preference. The reader merges the chain leaf by leaf and an
  // array is one leaf, so a later file's path list REPLACES an earlier one's; the lists are unioned per file instead,
  // so no chain file can remove another's protected paths (PR #6381 self-review).
  let plat = platform; let platUnreadable = false; let chainPlat; let chainFiles = [];
  if (plat === undefined) {
    try {
      // The reader skips a missing file silently. That is right for the default paths, but an EXPLICITLY configured
      // file that is missing is a choice we cannot read: it fails closed (PR #6381 judge). It is checked before AND
      // after the read so a file that appears or vanishes in between is not read as unset. A relative path would
      // resolve against whatever cwd the process has, so it fails closed too.
      // One snapshot of env feeds every read below, so the override cannot read as unset here and as set in the reader.
      const snap = { ...env };
      const configured = String(snap[PLATFORM_PREFERENCES_ENV] ?? '').trim();
      const configuredBad = () => configured !== '' && (!isAbsolute(configured) || !existsSync(configured));
      const before = configuredBad();
      const { prefs, errors } = readPlatformPreferences({ env: snap, readFile: platformRead, warn: () => {} });
      plat = prefs.audit;
      // A key that only folds to `audit` (`Audit`, `audit` plus a zero-width space) is a section the reader drops
      // unseen: every platform read below fails closed on one, with a warning naming it (PR #6381 judge).
      const variantSeen = new Set();
      const shadowed = obj => {
        const keys = auditVariants(obj);
        // At most 5 keys are named, each cut to 64 characters: the section fails closed whatever the count.
        for (const k of keys) if (!variantSeen.has(k) && variantSeen.size < 5) { variantSeen.add(k); warn(`audit platform preference key ${showKey(k.slice(0, 64))} is a variant of "audit"; the section is unreadable`); }
        return keys.length > 0;
      };
      platUnreadable = before || configuredBad() || errors.length > 0 || (Object.hasOwn(prefs, 'audit') && prefs.audit === null) || shadowed(prefs);
      // The default chain env: the override removed. Each chain file is read on its own through the same reader.
      const chainEnv = { ...snap }; delete chainEnv[PLATFORM_PREFERENCES_ENV];
      for (const p of [...LEGACY_PLATFORM_PREFERENCES_PATHS, PLATFORM_PREFERENCES_PATH, operatorPreferencesPath(chainEnv)]) {
        const one = readPlatformPreferences({ env: { ...chainEnv, [PLATFORM_PREFERENCES_ENV]: p }, readFile: platformRead, warn: () => {} });
        // A file unreadable here, or one whose present `audit` is not an object, is a choice we cannot read.
        if (one.errors.length > 0 || (Object.hasOwn(one.prefs, 'audit') && !isObj(one.prefs.audit)) || shadowed(one.prefs)) platUnreadable = true;
        if (isObj(one.prefs.audit)) chainFiles.push(one.prefs.audit);
      }
      if (configured !== '') {
        // An explicitly configured file with no object `audit` (absent, null or not an object — a package.json, `{}`)
        // sets no audit preference, yet it replaces the whole default chain: its protected paths would vanish with no
        // warning. That is a choice we cannot read, so it fails closed (PR #6381 judge).
        if (!isObj(prefs.audit)) platUnreadable = true;
        // The default chain, read with the override removed from env, supplies path lists the override adds to.
        const chain = readPlatformPreferences({ env: chainEnv, readFile: platformRead, warn: () => {} });
        chainPlat = chain.prefs.audit;
        // Read as it would be with no override: an unreadable chain or a present non-object `audit` fails closed.
        if (chain.errors.length > 0 || (Object.hasOwn(chain.prefs, 'audit') && !isObj(chainPlat)) || shadowed(chain.prefs)) platUnreadable = true;
        // The chain's single-value settings are a floor too: the override may only tighten them (PR #6381 self-review).
        if (!platUnreadable && isObj(chainPlat)) plat = tightenToChain(plat, chainPlat);
      }
    } catch { plat = undefined; chainPlat = undefined; chainFiles = []; platUnreadable = true; }
  }
  // A platform preference that is present but not an object flattens to one root leaf and reads as all-omitted.
  const platBad = platUnreadable || (plat !== undefined && plat !== null && !isObj(plat));
  if (platBad) warn(`audit platform preference ${platUnreadable ? 'unreadable' : 'is not an object'}; every setting resolves to its strictest option`);
  // The cascade still runs (it logs each policy's sources, and a layer it cannot survive fails closed), but no value is
  // read from its merge: it keys each leaf by its NUL-joined path, so an unknown key `"verdict" + NUL + "mode"` takes the
  // slot of `verdict.mode` and drops it, and an explicit shadow mode read as omitted (PR #6381 judge). Each setting is
  // read from the RAW layers instead, own keys only, the file over the platform, as the cascade layers them.
  let cascade;
  try { cascade = cascadePolicy('audit', tool, { standard: undefined, platform: plat === undefined ? null : plat, env, log }); } catch { cascade = null; }
  for (const [name, layer] of [['platform chain', chainPlat], ['platform', plat], ['file', tool]]) {
    const unknown = unknownKeys(layer);
    if (unknown.length) warn(`audit ${name} layer has unknown setting(s) ${JSON.stringify(unknown.slice(0, 20))}; ignored (check the spelling)`);
  }
  // Malformed RAW entries in any layer (raw only: the platform-level fault above is reported once, not per key). The
  // default chain read under an override counts: a malformed chain entry fails that setting closed.
  const malformed = (key, valid) => [...chainFiles, chainPlat, plat, tool].some(layer => rawMalformed(layer, key, valid) || caseShadowed(layer, key));
  const value = {}; const sources = {};
  for (const key of Object.keys(DEFAULTS)) {
    // The source names the layer the value came from: the cascade layers the file over the platform (PR #6381 send-back).
    const fromFile = ownGet(tool, key); const fromPlat = ownGet(plat, key);
    let v = fromFile !== undefined ? fromFile : fromPlat;
    let src = fromFile !== undefined ? 'file' : fromPlat !== undefined ? 'platform' : 'built-in';
    const bad = platBad || malformed(key, VALID[key]);
    if (v === undefined && !unreadable && cascade && !bad) { v = DEFAULTS[key]; src = 'built-in'; }
    if (unreadable || !cascade || bad || !VALID[key](v)) {
      if (!platBad && (unreadable || bad || v !== undefined)) { warn(`audit setting ${key} unreadable or invalid; using strictest ${JSON.stringify(STRICTEST[key])}`); }
      v = STRICTEST[key]; src = 'strictest';
    }
    // allow is never trusted: it resolves to block.
    if (key === 'preExistingMode' && v === 'allow') { warn('audit.preExisting.mode=allow resolves to block (the model label is never trusted)'); v = 'block'; }
    const envRaw = env?.[AUDIT_SETTINGS_ENV[key]];
    if (envRaw !== undefined) {
      const e = parseEnv(key, envRaw);
      // An env value that does not parse or is not a known option is an explicit choice we cannot read: strictest.
      if (e === undefined || !VALID[key](e)) {
        warn(`env ${AUDIT_SETTINGS_ENV[key]}=${JSON.stringify(envRaw)} invalid; using strictest ${JSON.stringify(STRICTEST[key])}`);
        v = STRICTEST[key]; src = 'strictest';
      } else if (key === 'preExistingMode' && e === 'allow') {
        // allow is never trusted, from any layer: it resolves to block (PR #6381 judge).
        warn(`env ${AUDIT_SETTINGS_ENV[key]}=allow resolves to block (the model label is never trusted)`); v = 'block'; src = 'env';
      } else if (tighter(key, e, v)) { v = e; src = 'env'; }
      else warn(`env ${AUDIT_SETTINGS_ENV[key]}=${JSON.stringify(envRaw)} ignored (env may only tighten)`);
    }
    value[key] = v; sources[key] = src;
  }
  // Path lists only ever ADD to the built-in floor. An unreadable layer or an invalid list (file, platform or env) is
  // an explicit choice we cannot read, so it resolves to the strictest list: the floor plus every path.
  // Each layer's list is read RAW and the lists are unioned: the cascade would let the file list REPLACE a platform
  // list, silently dropping the platform's extra protected paths (PR #6381 judge).
  // Under a platform-file override the default chain's lists are unioned in first, so the override only adds.
  for (const key of ['raceBlockPaths', 'guardFloorPaths']) {
    let strictest = unreadable || !cascade || platBad;
    const own = layer => (isObj(layer) ? layer[key] : undefined);
    const layerLists = [...chainFiles.map(own), own(chainPlat), own(plat), own(tool)].filter(l => l !== undefined);
    for (const patterns of layerLists) if (validPaths(patterns)) assertConfiguredPatterns(patterns);
    let platList = []; let list = [];
    if (!layerLists.every(validPaths) || malformed(key, validPaths)) { warn(`audit setting ${key} invalid; every path protected`); strictest = true; }
    else {
      platList = [...chainFiles.flatMap(f => own(f) ?? []), ...(own(chainPlat) ?? []), ...(own(plat) ?? [])];
      list = [...platList, ...(own(tool) ?? [])];
    }
    let envList = [];
    const raw = env?.[AUDIT_SETTINGS_ENV[key]];
    if (raw !== undefined) {
      let p; try { p = JSON.parse(raw); } catch { p = undefined; }
      if (validPaths(p)) { assertConfiguredPatterns(p); envList = p; }
      else { warn(`env ${AUDIT_SETTINGS_ENV[key]} invalid; every path protected`); strictest = true; }
    }
    value[key] = Object.freeze([...new Set([...(strictest ? STRICTEST_PATHS : GUARD_FLOOR), ...list, ...envList])]);
    assertConfiguredPatterns(value[key]);
    sources[key] = strictest ? 'strictest' : envList.length ? 'env' : list.length > platList.length ? 'file' : platList.length ? 'platform' : 'built-in';
  }
  // Prior question hashes only widen what is ACCEPTED, so only the trusted file may set them: no env route, and the
  // platform layer is ignored (as findAudit's reader ignores it — the team platform file must never widen acceptance).
  // A bad list is empty. Any unreadable layer accepts none (strictest), like every single-value setting above.
  if (isObj(plat) && Object.keys(plat).some(k => foldKey(k) === foldKey('priorQuestionHashes'))) {
    warn('audit platform preference priorQuestionHashes ignored; only the trusted settings file may accept prior hashes');
  }
  // Own keys only, as the cascade reads them: an inherited (prototype) value is never a setting.
  const hashes = isObj(tool) && Object.hasOwn(tool, 'priorQuestionHashes') ? tool.priorQuestionHashes : undefined;
  const hashesInvalid = rawMalformed(tool, 'priorQuestionHashes', validHashes) || caseShadowed(tool, 'priorQuestionHashes')
    || (hashes !== undefined && !validHashes(hashes));
  if (unreadable || !cascade || platBad || hashesInvalid) {
    if (hashesInvalid) warn('audit setting priorQuestionHashes invalid; none accepted');
    value.priorQuestionHashes = Object.freeze([]); sources.priorQuestionHashes = 'strictest';
  } else {
    value.priorQuestionHashes = Object.freeze(hashes === undefined ? [] : [...hashes]);
    sources.priorQuestionHashes = hashes === undefined ? 'built-in' : 'file';
  }
  return { value: Object.freeze(value), sources, warnings };
}
