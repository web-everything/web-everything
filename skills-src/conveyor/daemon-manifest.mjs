/**
 * @file skills-src/conveyor/daemon-manifest.mjs
 * @description #3871 (epic #3383) — the CLOSED ALLOWLIST {@link ../pass-daemon.mjs} resolves every launch
 *   through. `pass-daemon.mjs` never takes a raw script path from its own CLI flags — it takes a `--pass=<name>`
 *   and looks `name` up here. A name not registered here refuses, loudly, before anything spawns. This is the
 *   one thing every daemon launcher in this epic shares (the watcher-wiring slice #3873, the Supervisor
 *   manifest launcher #3874) — a single file naming every script this epic's daemons may ever start.
 *
 * STARTS EMPTY, BY DESIGN. This item builds the MECHANISM only — it introduces no changes to any existing
 * pass script, and registers none of them. #3873 (wiring the 8 watcher passes) and any later daemon-launcher
 * slice are what actually populate {@link DAEMON_MANIFEST}; each does so by editing THIS file, never by
 * teaching `pass-daemon.mjs` a new way to resolve a path. The mechanism is proven here with fixture entries
 * (see the test file), not real ones — a real entry is a one-line addition once its slice lands.
 *
 * @typedef {{ script: string, args?: string[], intervalMs: number, defaultLaunch?: boolean }} DaemonManifestEntry
 *   - `defaultLaunch`: `false` keeps the entry out of the supervisor launcher's default launch set (an entry
 *     that is only safe to start by name, e.g. a resident singleton). Absent/`true` = launched by default.
 *   - `script`: repo-relative path to the pass's own CLI entry point (e.g.
 *     `'scripts/conveyor/branch-drift.mjs'`), resolved against the repo root at spawn time — never absolute,
 *     never containing `..` (validated below).
 *   - `args`: the fixed argv this entry always spawns with (e.g. `['sweep']`) — not user-suppliable at launch
 *     time, so a manifest entry is a complete, reviewed launch spec, not a template.
 *   - `intervalMs`: how often {@link ../pass-daemon.mjs} re-runs this pass after each run completes.
 */

import { CONSTELLATION_REPOS } from '../../scripts/lib/constellation-repos.mjs';

/** Every mechanical pass ran at this same cadence as one of `runner.mjs`'s own `makeCliMechanicalPasses`
 *  steps — unchanged here, since #3873 wires the SAME passes onto standalone daemons, not a redesign of how
 *  often they run. */
const DEFAULT_PASS_INTERVAL_MS = 120_000;

/** PR #3881/#3932 — the load-flake re-verify pass. Each run is a cheap loadavg read unless the host is quiet,
 *  so 5 minutes is plenty; `WE_LOAD_FLAKE_REVERIFY_INTERVAL_MS` overrides it (read once, at manifest load). */
export function loadFlakeReverifyIntervalMs(env = process.env) {
  const n = Number(env.WE_LOAD_FLAKE_REVERIFY_INTERVAL_MS);
  return Number.isFinite(n) && n > 0 ? n : 5 * 60_000;
}

/**
 * #3873 — one manifest entry per (repo-generic pass × constellation repo), matching exactly what
 * `runner.mjs`'s own per-repo loop already does today (`run(path, args, key, slug)` appends `--repo=${slug}`
 * for every repo in `CONSTELLATION_REPOS`). A single WE-only entry per pass here would have silently
 * narrowed each one's real coverage from three repos down to one — the exact class of bug just live-caught
 * and fixed in `we:skills-src/conveyor/review-daemon.mjs` (#xvyuwtg, plateau-app PR #167 sat unwatched
 * because ITS daemon never asked any repo but WE). Named `<passName>-<repoKey>` (e.g. `ci-queue-watch-we`,
 * `ci-queue-watch-plateau-app`) so each repo's sweep is its own independently-launchable, independently-leased
 * pass-daemon process — consistent with this whole epic's "many small independent daemons" shape, not a
 * special case.
 * @param {string} passName
 * @param {string} script
 * @param {string[]} args
 * @returns {Record<string, DaemonManifestEntry>}
 */
function perRepoEntries(passName, script, args) {
  const out = {};
  for (const [key, { slug }] of Object.entries(CONSTELLATION_REPOS)) {
    out[`${passName}-${key}`] = { script, args: [...args, `--repo=${slug}`], intervalMs: DEFAULT_PASS_INTERVAL_MS };
  }
  return out;
}

/**
 * #3873 (epic #3383) — the 8 watcher passes named in that card's scope, wired onto `pass-daemon.mjs`.
 *
 * ONE NAMED SCRIPT DOES NOT EXIST ON `main`: `poc-branch-sync.mjs`. Confirmed by direct read (no such file
 * under `scripts/conveyor/`, and no reference to it anywhere in the tree outside a stray, unrelated
 * `.git/poc-branch-sync` ref) — a false premise carried into the card's scope, corrected here rather than
 * invented from scratch (inventing a new pass's own logic is a different, much bigger task than "wire an
 * existing pass"). The other 7 are real and wired below.
 *
 * THREE stay WE-only, genuinely — not a coverage gap, a real invariant of each:
 *   - `branch-drift.mjs` / `infra-blocked.mjs` — neither script HAS a `--repo` flag at all (confirmed by
 *     direct read); both monitor WE-specific concepts (the WE mechanical-dispatcher branch; WE backlog
 *     infra holds) with no cross-repo equivalent to watch.
 *   - `duplicate-pr-watch.mjs` — DOES accept `--repo`, but `runner.mjs`'s own comment states why it is never
 *     called with one: "duplicate item numbers refer to WE backlog ids, not cross-repo deliveries." Using it
 *     cross-repo would be semantically wrong, not merely unbuilt.
 *
 * FOUR are wired per-repo via {@link perRepoEntries}, matching their own real, already-cross-repo behavior
 * in `runner.mjs` today: `ci-queue-watch.mjs`, `parked-pr-conflict-watch.mjs`, `parked-pr-progress-watch.mjs`,
 * `lane-pool-health-watch.mjs` (the last of these matters concretely: plateau-app's own lane pool has no
 * health-watch coverage today precisely because nothing runs this pass against it — live-caught 2026-09-22
 * investigating why plateau-app PR #167 couldn't get a review lane).
 *
 * `runner.mjs`'s own `makeCliMechanicalPasses` still runs all 7 scripts inline, unchanged, in this same PR —
 * per the card's own "drop each from runner.mjs's own mechanicalPasses list AS IT BAKES" (a rolling,
 * pass-by-pass cutover, the same discipline #3870/#3876 already followed): standing up a daemon here does
 * not yet retire the old runner's own copy of the same sweep.
 */
/**
 * #3913 — the orphaned-claim release pass runs far less often than the watchers: it acts on cards idle for
 * over 48 h and each writing run opens a PR, so a 6-hour cadence loses nothing and keeps the PR rate low. It
 * never stacks PRs — a run that sees its own previous PR still open writes nothing.
 */
const ORPHAN_CLAIM_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * epic #3383 — the ORPHAN-PR SWEEP (`scripts/merge-ai-prs.mjs`, bare/no `--label`), wired onto `pass-daemon.mjs`
 * for the FIRST time. Found live (PR #2504, `lane/wip-socket-card`): a PR carrying ONLY the `checking` label
 * (CI green, nothing else) has no `.lane-manifest.json`-derived owner, so `reconcile-pass.mjs` reports it
 * `nothing-owed`/phase `open` — genuinely correct, since reconcile only tracks producer-completed
 * (`ready-to-merge`-labelled) or review-parked PRs, never a bare AI-authored PR sitting on `checking` with no
 * label transition at all. The one pass that DOES cover this population is documented in `merge-ai-prs.mjs`'s
 * own header: bare (no `--label`) is "the `/merge` orphan sweep" — every OTHER daemon in this epic (the
 * review daemon, the fix-dispatch daemon, every `pass-daemon.mjs` watcher above) is downstream of
 * `reconcile-pass.mjs`'s own discovery, so NONE of them would ever surface #2504 either; only the bare sweep
 * lists ALL open PRs directly via its own `gh pr list`, independent of reconcile.
 *
 * SAFE TO RUN PERIODICALLADY, UNCONDITIONALLY, ALONGSIDE ANY OTHER LANDER. `merge-ai-prs.mjs`'s own header
 * ("SOLE WRITER TO MAIN #2290") already serializes every real `gh pr merge` through its own whole-process drain
 * lease + `pr-merge-gate.mjs` — the SAME mutual-exclusion primitive an interactive `/merge`/`/pr`/`/finish`
 * run, or an already-resident `--label=ready-to-merge --watch` drain (if one is running), also goes through.
 * So EITHER this periodic bare sweep is the only lander touching an orphan PR (the live #2504 case — it does
 * real, needed work), OR another lander already holds the drain lease this tick (a no-op, exactly the
 * "efficiency no-op, not a safety refusal" shape `reconcile-fix-dispatch-daemon.mjs`'s own header already
 * documents for its analogous case) — this manifest entry is correct and inert-when-redundant either way, so
 * it does not need to know which case is live before being added. `pass-daemon.mjs`'s OWN lease (this entry's
 * name, `merge-orphan-sweep`) only prevents TWO COPIES of this SAME periodic sweep — a separate concern from
 * `merge-ai-prs.mjs`'s own internal drain lease, which is what actually protects `main`.
 *
 * NEVER `--label=ready-to-merge` here — that is the DIFFERENT, already-covered `/drain` role (a resident watch,
 * if one exists, is out of this epic's scope; this entry deliberately does not duplicate it). No `--repos`/
 * `--this-repo` either — bare already defaults to the full constellation (self + WE/FrontierUI/plateau-app,
 * confirmed by direct read of `resolveRepos`'s own `#2287` comment), matching the `/merge` skill's own scope.
 *
 * INTERVAL: real merges are heavier than a read-only watch (a `gh pr list` sweep across the constellation plus
 * a possible `gh pr merge`+branch-delete per qualifying PR) — 15 minutes is generous enough that an orphaned
 * PR is never stuck for long (unlike `orphan-claim-release`'s 6 h, which acts on cards idle for 48 h+) while
 * staying well clear of API rate-limit pressure the file header's own `xsdm0n7` finding named for this exact
 * daemon family.
 */
const MERGE_ORPHAN_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/** #4077 — the health watch's tick cadence (design: 5 minutes; its GitHub probes self-throttle to 15). */
const HEALTH_WATCH_INTERVAL_MS = 5 * 60 * 1000;

export const DAEMON_MANIFEST = {
  // Resident-only: `tick` throws unless the resident `--daemon` owner injected its lease, so the supervisor
  // launcher's default launch set must never spawn it bare. Still resolvable by name for the resident start.
  'health-responder': { script: 'scripts/conveyor/health-responder.mjs', args: ['tick'], intervalMs: 60_000, defaultLaunch: false },
  'orphan-claim-release': { script: 'scripts/conveyor/orphan-claim-release.mjs', args: ['--apply'], intervalMs: ORPHAN_CLAIM_INTERVAL_MS },
  'merge-orphan-sweep': { script: 'scripts/merge-ai-prs.mjs', args: [], intervalMs: MERGE_ORPHAN_SWEEP_INTERVAL_MS },
  'branch-drift': { script: 'scripts/conveyor/branch-drift.mjs', args: ['sweep'], intervalMs: DEFAULT_PASS_INTERVAL_MS },
  'load-flake-reverify': { script: 'scripts/conveyor/load-flake-reverify.mjs', args: ['sweep'], intervalMs: loadFlakeReverifyIntervalMs() },
  'infra-blocked': { script: 'scripts/conveyor/infra-blocked.mjs', args: ['retry'], intervalMs: DEFAULT_PASS_INTERVAL_MS },
  'duplicate-pr-watch': { script: 'scripts/conveyor/duplicate-pr-watch.mjs', args: ['sweep'], intervalMs: DEFAULT_PASS_INTERVAL_MS },
  // #3383 — live-caught 2026-09-24: `scripts/conveyor/lease-reaper.mjs` (reclaims a lane lease whose owning
  // session is confirmed gone, via its session-gone/ttl-stale/pr-terminal axes) had gone the SAME way
  // `session-reaper.mjs` had before #3982's fix — its only historical caller was `runner.mjs`'s own
  // `makeCliMechanicalPasses`, which this epic's daemon split has since retired, and #3873's own "wire the 8
  // watcher passes" slice never named it (it names a different, narrower set — the read-only watchers, not
  // this reaper). Left uncalled, no daemon ever runs its session-gone axis, so any lease that axis alone could
  // reclaim (e.g. a non-dispatcher-grammar session name, which the PR-merged/PR-closed axis already run
  // inline by `acquire`'s own `reapDeadLeasesInPool` backstop can never resolve to an item) sits held until
  // pure TTL (4h default) elapses — live-observed: 9 such leases outliving real spare pool capacity.
  // WE-only, no `--repo`: unlike the per-repo watchers above, this pass is REPO-AGNOSTIC by design — with no
  // `--pool` flag it walks every pool under the shared `LANE_POOL_ROOT` (every constellation repo) in ONE
  // process (confirmed by direct read of its own `poolsToScan`), so one manifest entry already covers the
  // whole constellation; a second, per-repo copy would just re-scan the same pools redundantly.
  'lease-reaper': { script: 'scripts/conveyor/lease-reaper.mjs', args: [], intervalMs: DEFAULT_PASS_INTERVAL_MS },
  ...perRepoEntries('ci-queue-watch', 'scripts/conveyor/ci-queue-watch.mjs', ['sweep']),
  // we:backlog/x5uqim1-*.md (#4075/#3383) — the CI-RED-RECOVERY watcher, wired per-repo like `ci-queue-watch`
  // above (see `we:scripts/conveyor/ci-red-recovery-watch.mjs`'s own file header for why THIS shape — a
  // pass-daemon watcher, never the drain and never the fix-dispatch daemon — is the right home, and for the
  // mid-build correction from a `gh run rerun` design to refreshing the branch onto `main` via the existing
  // `we:scripts/lib/rebase-drop-manifest.mjs` plumbing). `--apply` is passed here, unlike an operator's own bare
  // `sweep`, because a daemon entry's whole point is to actually refresh a candidate's branch once it clears
  // every gate; the pass's own idempotent cap (`already-current` once `main`'s tip is already an ancestor of
  // the PR's head, read back off GitHub's own `compare` endpoint, no parallel store — AND `rebaseDropManifest`'s
  // own independent `action:'current'` short-circuit) is what makes running this unconditionally on the default
  // cadence safe — the same "efficiency no-op, not a safety refusal" trade `merge-orphan-sweep` above already
  // documents for its own always-on entry.
  ...perRepoEntries('ci-red-recovery-watch', 'scripts/conveyor/ci-red-recovery-watch.mjs', ['sweep', '--apply']),
  ...perRepoEntries('parked-pr-conflict-watch', 'scripts/conveyor/parked-pr-conflict-watch.mjs', ['sweep']),
  ...perRepoEntries('parked-pr-progress-watch', 'scripts/conveyor/parked-pr-progress-watch.mjs', ['sweep']),
  ...perRepoEntries('lane-pool-health-watch', 'scripts/conveyor/lane-pool-health-watch.mjs', []),
  // #3383's stuck-PR watch — per-repo, matching the shape above: catches an open PR stalled past its stage's
  // own expected time and dispatches ONE diagnosis-only inspection agent per stuck episode
  // (`we:scripts/conveyor/stuck-pr-watch.mjs`, `we:scripts/conveyor/stuck-pr-watch-core.mjs`).
  ...perRepoEntries('stuck-pr-watch', 'scripts/conveyor/stuck-pr-watch.mjs', ['sweep']),
  // The ~60s process sampler behind the heavy-run-ungated smell.
  // Runs under pass-daemon.mjs --pass=heavy-run-sample (opt-in).
  'heavy-run-sample': { script: 'scripts/conveyor/heavy-run-ungated.mjs', args: ['sample'], intervalMs: 60_000, defaultLaunch: false },
  // #4077 (ruling #4065) — the HEALTH WATCH: one host-wide entry (not per-repo — its host smells read every
  // daemon's log/lease on this machine, and its one `gh pr list` sweep already covers the constellation). A
  // 5-minute tick; the script's own watchdog caps a tick at 3x its 60 s budget and writes its own
  // last-tick-completed stamp. Runs from its OWN dedicated clone (4065 Fork 1) with self-sync set explicitly in
  // its plist — see we:skills-src/conveyor/launchd/com.we.health-watch.plist.example.
  'health-watch': { script: 'scripts/conveyor/health-watch.mjs', args: ['tick'], intervalMs: HEALTH_WATCH_INTERVAL_MS },
};

/** A script path may be `undefined` is never intended; it must be a plain repo-relative path with no `..`
 *  traversal and no leading `/` — the same shape every `we:` locus-prefixed reference in this repo already
 *  uses, checked here as CODE (not just convention) since this is the one gate standing between a manifest
 *  entry and a real spawn. */
export function isSafeManifestScriptPath(script) {
  return typeof script === 'string' && script.length > 0
    && !script.startsWith('/') && !script.includes('..') && !script.includes('\0');
}

/** Validate one manifest entry's shape. Pure — throws with a specific reason rather than returning a bool,
 *  so a malformed entry (a typo'd field, a negative interval) fails LOUDLY at registration time, never
 *  silently at first spawn. */
export function assertValidManifestEntry(name, entry) {
  if (!entry || typeof entry !== 'object') throw new TypeError(`daemon-manifest: entry "${name}" is not an object`);
  if (!isSafeManifestScriptPath(entry.script)) {
    throw new TypeError(`daemon-manifest: entry "${name}"'s script must be a repo-relative path with no ".." or leading "/" (got ${JSON.stringify(entry.script)})`);
  }
  if (entry.args !== undefined && (!Array.isArray(entry.args) || !entry.args.every((a) => typeof a === 'string'))) {
    throw new TypeError(`daemon-manifest: entry "${name}"'s args must be an array of strings`);
  }
  if (entry.defaultLaunch !== undefined && typeof entry.defaultLaunch !== 'boolean') {
    throw new TypeError(`daemon-manifest: entry "${name}"'s defaultLaunch must be a boolean`);
  }
  if (!Number.isFinite(entry.intervalMs) || entry.intervalMs <= 0) {
    throw new TypeError(`daemon-manifest: entry "${name}"'s intervalMs must be a positive number (got ${JSON.stringify(entry.intervalMs)})`);
  }
  return entry;
}

/**
 * THE closed-allowlist lookup — the one function {@link ../pass-daemon.mjs} calls to turn a `--pass=<name>`
 * flag into a real, spawnable entry. Refuses (never returns a made-up default) for any `name` not registered,
 * naming every currently-known entry in the refusal so a typo is obvious. Re-validates the entry on every
 * lookup (not just at author time) — cheap, and it means a manifest that somehow got corrupted on disk still
 * fails closed rather than spawning something malformed.
 * @param {string} name
 * @param {Record<string, DaemonManifestEntry>} [manifest]
 * @returns {DaemonManifestEntry}
 */
export function resolveManifestEntry(name, manifest = DAEMON_MANIFEST) {
  const entry = manifest[name];
  if (!entry) {
    const known = Object.keys(manifest).sort();
    throw new Error(
      `pass-daemon: "${name}" is not in the daemon manifest — pass-daemon never takes a raw script path. `
      + (known.length ? `Known entries: ${known.join(', ')}.` : 'No entries are registered yet.'),
    );
  }
  return assertValidManifestEntry(name, entry);
}
