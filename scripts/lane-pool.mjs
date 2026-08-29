#!/usr/bin/env node
/**
 * lane-pool.mjs — provision & refresh the persistent lane-clone pool for the #1933 clone-based
 * parallel batch orchestrator (slice 2).
 *
 * The #1933 model replaces guard-blocked `git worktree` isolation with N independent CLONES: each lane
 * is a full clone with its OWN HEAD (so the user-global git-branch guard, which protects the shared
 * checkout's HEAD, never fires on it), and convergence happens through the remote — a lane pushes its
 * work to a throwaway `lane/*` ref (allowed by the #1934 guard carve-out) and the central integrator
 * merges those into `main`. This script owns the *pool*: it creates/refreshes the clones the
 * orchestrator dispatches into; it does NOT dispatch, push, or merge (that's slice 3).
 *
 * Why a PERSISTENT pool (per #1933 design choice 1): re-cloning a large repo every batch is slow, so the
 * lanes are long-lived under `~/workspace/.lanes/<repo>/lane-<n>` and merely fetch + hard-reset to
 * origin/main between batches. Git OBJECTS are shared with the primary checkout via `git clone
 * --reference`, so a lane costs little disk and clones fast (objects come from the local primary, not the
 * network). Node deps (`node_modules`) are NOT shared — `ensureDeps` runs `npm ci` per lane on a fresh
 * clone or when the lockfile changes, so each lane can run its own gate.
 *
 * Repo-parameterized: the pool is keyed by repo NAME, so cross-repo slice 4 (lanes of
 * frontierui / plateau-app — the constellation) reuses this unchanged via `--repo=<checkout-path>`.
 *
 * Usage:
 *   node scripts/lane-pool.mjs provision --count=N [--acquirable] [--no-install] [--force]   # ensure N lanes exist (clone missing) + refresh all + ensure deps + ensure the WE pool's FUI render-sibling (#2166); --acquirable grows PAST foreign-leased lanes so N ACQUIRABLE ones result (#2426)
 *   node scripts/lane-pool.mjs refresh           [--no-install] [--force]     # fetch + hard-reset existing lanes to origin/main (no creation)
 *   node scripts/lane-pool.mjs status  [--json]                     # per-lane: path / head / clean / behind origin/main / deps / lease
 *   node scripts/lane-pool.mjs list    [--json] [--acquirable]      # existing lane paths (for the orchestrator to dispatch into); --acquirable filters out foreign-leased / busy lanes (#2426)
 *   node scripts/lane-pool.mjs path    --lane=N                     # print one lane's absolute path
 *   node scripts/lane-pool.mjs acquire [--purpose=<slug>] [--session=<slug>] [--lane=N] [--item=NNN[,NNN…]] [--ttl-minutes=N] [--no-reset] [--no-reap] [--base=<ref>] [--scope=<repo:path,...>] [--reserve] [--json]  # #2275 lease a free lane (exclusive) + reset to origin/main (or, with #2386 --base=<ref>, to a predecessor lane's pushed tip); stdout = its path. #2748: BEFORE selecting, a reaper backstop reclaims any PROVABLY-DEAD ghost lease in the pool (item resolved on main, or PR merged/closed) so a finished-but-unreleased lane never blocks a fresh dispatch — the pool ACTS on the ghost the board only flags; --no-reap opts out. #2413: --purpose=workflow-lane MARKS the lease (workflowLane:true) → the guard requires a sibling to assert its minted slug before a destructive op. #2560: --scope=<repo:path,...> declares this lane's ADVISORY predicted file-scope — persisted into the marker (the live scope-lease collector reads it) + warns on overlap, but NEVER gates the acquire (the whole-clone lease is the real lock). #2616: --item=NNN records this lane's item → lane in the lane-ports registry (same as `map`) so conveyor-state's health-stall scan can flag a genuinely stalled lane — the self-serve population a conveyor delivery agent needs (nothing else calls `map` for it). #2350: --reserve (requires --lane=N) mints a PERMANENT reserved lane — no TTL, never stale, off-limits to acquire/refresh/provision (even --force); dropped only by `release --release-reserved`. #2997: EVERY acquire now mints a per-holder `holder` slug into the lease and prints it (stderr + --json `holder`) — the one signal that separates this holder from a SIBLING agent of the same session, which `ownerSession` cannot; assert it as `--session=<slug>` (release) or `LANE_SESSION=<slug>` (a destructive git op) whenever a sibling of your session also holds a live lane. #2997 r2: --adopt also stamps YOU as the lane's OCCUPANT (`workerSession`) — pass it when the process running this acquire is the one that will work in the lane, omit it when you are leasing on someone else's behalf (they run `adopt` instead).
 *   node scripts/lane-pool.mjs adopt   --lane=N [--force] [--json]   # #2997 r2 the dispatcher → worker OCCUPANCY hand-off: declare the CALLING session the agent working in lane-N (stamps `workerSession`), which is what arms guard-lane.mjs's Edit/Write refusal against every OTHER session. `ownerSession` cannot do this job — it records whoever RAN `acquire`, which for a dispatched lane is the dispatcher, not the worker. Idempotent; a lane already declared-occupied by a different LIVE session needs --force (a deliberate takeover, which names who is displaced).
 *   node scripts/lane-pool.mjs release (--lane=N | --all | --all-pools (--session=<slug> | --item=<num>)) [--session=<slug>] [--pool=<name>] [--force] [--release-reserved]   # #2275 hand a leased lane back to the pool (own lease, or --force); #2350 --release-reserved is the deliberate un-reserve for a PERMANENT reserved lane (--force alone never drops one); #2667 --all-pools --session sweeps EVERY pool under POOL_ROOT and releases that session's leases (cross-locus couple cleanup in one call), and --pool=<name> selects a pool by dir-name (no checkout path needed); #2748 --all-pools --item=<num> is the by-ITEM sweep the drain's release-on-land uses (matches every lease whose session encodes that item number — needs no exact slug); #2997 a CONTESTED lease (another live lease — in ANY pool under POOL_ROOT, per r2 — shares its ownerSession, i.e. a sibling agent of yours holds a lane) is never released on the ownerSession match alone — pass `--session=<the holder slug acquire printed>` or `--force`. A STALE lease is never contested (r2): a dead holder has nothing to prove, so an expired lease releases without --force exactly as on main.
 *   node scripts/lane-pool.mjs remove  (--lane=N | --all)           # tear down lane(s); #2350 REFUSES a reserved lane (even --all/--force) — deliberate teardown is `remove --lane=N --release-reserved`
 *   node scripts/lane-pool.mjs map     --lane=N --item=NNN[,NNN…]   # register item(s) → lane page-port (#2139 proxy)
 *   node scripts/lane-pool.mjs unmap   (--item=NNN[,…] | --lane=N | --all)   # drop lane-ports registry entries
 *
 * Repo / pool overrides (apply to any command):
 *   --repo=<path>        a checkout to derive the lane repo from (default: the cwd's git toplevel)
 *   --pool=<name>        (#2667) select a pool DIRECTLY by its dir-name under POOL_ROOT — the read/release
 *                        selector (status / list / path / release) that needs only the poolDir, no checkout path
 *                        or origin URL (e.g. release a plateau-app-pool lease from the WE checkout)
 *   --origin=<url>       clone source (default: that checkout's `origin` remote URL)
 *   --reference=<path>   object-sharing reference repo for `git clone --reference` (default: --repo path)
 *   --name=<slug>        pool key under the root (default: derived from the origin URL basename)
 *   --branch=<ref>       integration branch (default: detected origin/HEAD, else `main`)
 *   env LANE_POOL_ROOT   pool root (default: ~/workspace/.lanes)
 *
 * SAFETY (#2267): a lane is safe scratch ONLY for work that is clean-and-up-to-date, or that this guard
 * has skipped. `refresh`/`provision` never silently discard a lane that is DIRTY (uncommitted edits) or
 * AHEAD of origin/<branch> (locally-committed-but-unpushed commits) — such a lane is SKIPPED (left
 * untouched) and reported, because `reset --hard` + `clean -fd` would otherwise destroy that work with no
 * recovery. Pass --force to restore the old unconditional reset-everything behavior for a dirty/ahead lane.
 * The only state a lane can rely on surviving a concurrent refresh/provision is what has ALREADY been
 * pushed to origin (i.e. landed via `pr-land` onto its `lane/*` ref, per #1934) — treat anything else as
 * ephemeral and push early.
 *
 * SAFETY (#2275/#2337): a LIVE lease (an exclusive hold stamped by `acquire`, presumed alive within TTL) is
 * a STRONGER guard than dirty/ahead — it protects an active consumer, not just tree residue. `--force`
 * overrides the dirty/ahead staleness guard but NEVER a live lease: `refresh --force` / `provision --force`
 * SKIP a live-leased lane with a loud log (never reset it); `acquire --lane=N --force` on a live-leased lane
 * HARD-FAILS, pointing at the deliberate override — `release --force` (drop the lease), then re-acquire. No
 * separate `--force-lease` flag exists; `release --force` is the one escape hatch for a live lease.
 *
 * SAFETY (#2350): a RESERVED lease (`acquire --reserve --lane=N`) is STRONGER still than a live lease — it is a
 * PERMANENT hold with no TTL that never goes stale, so it is off-limits to acquire (auto-pick skips it; an
 * explicit `acquire --lane=N` HARD-FAILS on it, even with `--force`) AND to `refresh`/`provision` `reset --hard`
 * (skipped forever, even with `--force`). It is the dedicated persistent memory-lane primitive (#2301/#2350):
 * a durable slot the running session can write through without a lane→PR round-trip, kept off the primary
 * checkout and off the recyclable pool. `--force` NEVER drops it; the ONE deliberate un-reserve is
 * `release --lane=N --release-reserved`. (NOTE: this script only PROVISIONS the reserved lane; the live repoint
 * of the machine-global `~/.claude/…/memory` symlink at it is the SUPERVISED, human-gated half of #2350.)
 */
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { homedir, hostname } from 'node:os';
import { join, basename, resolve, dirname } from 'node:path';
import { defaultPoolRoot, referenceArgs } from './lib/lane-pool-paths.mjs';
import {
  LEASE_FILENAME,
  DEFAULT_LEASE_TTL_MINUTES,
  WORKFLOW_LANE_PURPOSE,
  isLeaseStale,
  isReservedLease,
  isLaneAcquirable,
  chooseFreeLane,
  leaseBody,
  describeLease,
  leaseOwnedBy,
  leaseOwnedByCaller,
  laneHolderSlug,
  laneWorkerSession,
  isContestedLease,
  isTransientRefLockError,
} from './lib/lane-lease.mjs';
// #2560 — lane-pool may freely import readiness (confirmed no circular import): the advisory scope-lease check
// at acquire. normScope normalizes the declared `--scope`; candidateLaunch is the pure overlap-at-launch query.
import { normScope } from './readiness/scope-lease.mjs';
import { candidateLaunch } from './readiness/scope-lease-live.mjs';
// #2748 — REUSE the standalone reaper's PURE core so the "provably-dead lease" verdict is SINGLE-SOURCED with
// `scripts/conveyor/lease-reaper.mjs` (the acquire-native backstop must agree with the periodic reaper, never
// fork its logic). Importing lease-reaper is side-effect-free — its IO shell is gated on the main-module check —
// and forms no cycle (lease-reaper imports only `lib/lane-lease.mjs`, never lane-pool). `readField` reads the
// frontmatter-strict `status:` for the offline item-resolved reap axis (#2603 spoof-safe reader).
import { classifyReap, reapPlan, prStatesFromList, itemNumFromSession } from './conveyor/lease-reaper.mjs';
import { readField } from './backlog/frontmatter.mjs';

// #2560 — `--scope=a,b,c` → a normalized, repo-qualified array (empty when the flag is absent/blank).
const parseScopeFlag = (v) => (typeof v === 'string' && v ? normScope(v.split(',')) : []);

// ── tiny arg parsing ──────────────────────────────────────────────────────────────────────────────
const [, , cmd, ...rest] = process.argv;
const flags = {};
const positionals = [];
for (const a of rest) {
  if (a.startsWith('--')) {
    const eq = a.indexOf('=');
    if (eq === -1) flags[a.slice(2)] = true;
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  } else positionals.push(a);
}

// ── git helpers (throw-on-error wrappers) ───────────────────────────────────────────────────────────
// `opts` merges into execFileSync's options (e.g. `{ timeout: 8000 }`) — needed by callers that must
// never let a slow/hung git call stall a dispatch acquire, matching the adjacent `gh` call's timeout.
const git = (args, cwd, opts = {}) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const gitQuiet = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'ignore', 'inherit'] });
const tryGit = (args, cwd, opts = {}) => {
  try {
    return git(args, cwd, opts);
  } catch {
    return null;
  }
};

// Live-fire dispatch test, 2026-08-29: `git fetch origin --prune` crashed `provision`/`acquire` outright —
// "error: cannot lock ref '<ref>': is at X but expected Y" — a transient race over the SHARED object store
// every lane clones `--reference` (two lanes' fetches touching the same `refs/remotes/origin/*` at once).
// On a host running several concurrent sessions this is ORDINARY contention, not a real failure, yet it was
// an uncaught throw that aborted the whole batch — and `acquire`'s OWN fetch (this same call) is the very
// FIRST git command a dispatched delivery agent's brief runs, so an unlucky race there crashed the agent
// before it ever reached `lane-pool acquire`'s own retry-free call. Retry a FEW times with a short backoff,
// matching only this specific ref-lock signature — any other fetch failure (network down, bad remote) still
// throws immediately, unretried, exactly as before.
const FETCH_LOCK_RETRY_ATTEMPTS = 4;
const FETCH_LOCK_RETRY_BASE_MS = 250;
function blockingSleep(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms)); } catch { /* env without SAB — skip the wait */ }
}
function fetchOriginPruneWithRetry(dir) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return git(['fetch', 'origin', '--prune', '--quiet'], dir);
    } catch (e) {
      const msg = String(e?.stderr || e?.message || e);
      if (!isTransientRefLockError(msg) || attempt >= FETCH_LOCK_RETRY_ATTEMPTS) throw e;
      blockingSleep(FETCH_LOCK_RETRY_BASE_MS * attempt);
    }
  }
}

const expandHome = (p) => (p && p.startsWith('~') ? join(homedir(), p.slice(1)) : p);

// #3265 — the pool root is DERIVED from the checkout, not assumed from `$HOME`. Pure core + its
// rationale live in `./lib/lane-pool-paths.mjs` (this file runs its CLI at import, so nothing here is
// unit-testable by importing it).
// The checkout ROOT, not the cwd: `defaultPoolRoot` is pure and cannot tell `<checkout>/scripts` from
// `<checkout>`, so handing it a subdirectory would put the pool INSIDE the repo (#1539 reviewer, round 2).
// A lane needs no normalising — `workspaceFor` strips at `.lanes` from any depth — but this is the honest
// input either way. Falls back to the cwd outside a git repo, where there is nothing better to say.
const CHECKOUT_ROOT = tryGit(['rev-parse', '--show-toplevel'], process.cwd()) || process.cwd();
const POOL_ROOT = defaultPoolRoot(CHECKOUT_ROOT);

// ── repo descriptor resolution ──────────────────────────────────────────────────────────────────────
function resolveRepo() {
  const repoPath = resolve(expandHome(flags.repo) || process.cwd());
  const referencePath = resolve(expandHome(flags.reference) || repoPath);
  const topLevel = tryGit(['rev-parse', '--show-toplevel'], referencePath) || referencePath;
  const originUrl = flags.origin || tryGit(['remote', 'get-url', 'origin'], topLevel);
  // #2667 — `--pool=<name>` selects a pool DIRECTLY by its directory name under POOL_ROOT, bypassing origin-URL
  // derivation. It is the pool selector for the READ / RELEASE ops (status / list / path / release) that need
  // only `poolDir` — e.g. the main session releasing a cross-locus couple's lingering lease in the `plateau-app`
  // pool from the WE checkout, without needing a plateau-app checkout path. When `--pool` names the pool an
  // undeterminable origin URL is NOT fatal (these ops never clone). `acquire`/`provision`/`refresh` still need a
  // real origin, and hit the same guard at use (`cloneLane` throws on a null origin) — so the fail just moves
  // from resolve-time to the op that actually needs it, keeping the read/release selector usable without one.
  const explicitPool = typeof flags.pool === 'string' && flags.pool ? flags.pool : null;
  if (!originUrl && !explicitPool) {
    fail(`could not determine an origin URL — pass --origin=<url> (looked in ${topLevel})`);
  }
  const name = explicitPool || flags.name || basename(originUrl).replace(/\.git$/, '');
  // Default integration branch: the reference's origin/HEAD if known, else `main`.
  const head = tryGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], topLevel);
  const branch = flags.branch || (head ? head.replace(/^origin\//, '') : 'main');
  return { name, originUrl: originUrl || null, referencePath: topLevel, branch, poolDir: join(POOL_ROOT, name) };
}

const laneDir = (repo, n) => join(repo.poolDir, `lane-${n}`);

/**
 * Is this checkout a shallow clone? Returns `null` when the probe itself fails, which `referenceArgs` reads as
 * "not proven shallow" — degrading to today's behaviour rather than dropping object sharing on a failed `git`.
 */
const isShallowRepo = (dir) => {
  const out = tryGit(['rev-parse', '--is-shallow-repository'], dir);
  return out === null ? null : out === 'true';
};

/** #3265 — the DECISION is pure and lives in `./lib/lane-pool-paths.mjs`; this just supplies the probe. */
const cloneReferenceArgs = (p) => referenceArgs(p, isShallowRepo(p));

// ── per-lane dev-server ports (#1997, per #1996 Fork 2) ──────────────────────────────────────────────
// A lane boots its own `npm run dev` on a deterministic per-index port pair, so N clones never collide.
// The formula is a PURE function of the lane index (no free-port scan, no registry — the pool index IS
// the allocator, #1996 Fork 2(a)): index N → BAND_BASE + 100 + N*10. The primary checkout keeps the band
// base (e.g. WE's 3000/8080 — the human's `npm start`). Config reads these via `.env.local` (vite.config
// reads `process.env`, the dev script reads `${WE_*_PORT:-default}`), with `strictPort` so a squatted
// port fails loud rather than silently binding the next one (which would desync the 11ty proxy target).
//
// Per-repo bands (#1996): WE `3000`/`8080`; plateau-app `4000`; FUI `6000`/`6080`. Only repos whose dev
// servers are env-driven need an entry here; a repo with no band writes no `.env.local` (harmless no-op).
const PORT_BANDS = {
  'web-everything': { WE_VITE_PORT: 3000, WE_ELEVENTY_PORT: 8080 },
  webeverything: { WE_VITE_PORT: 3000, WE_ELEVENTY_PORT: 8080 },
};
function laneEnvLocal(repo, n) {
  const band = PORT_BANDS[repo.name];
  if (!band) return null; // repo has no env-driven dev band → nothing to generate
  const body = Object.entries(band)
    .map(([key, base]) => `${key}=${base + 100 + n * 10}`)
    .join('\n');
  return (
    `# Generated by scripts/lane-pool.mjs (#1997) — deterministic per-lane dev-server ports.\n` +
    `# Lane ${n} of pool "${repo.name}"; regenerated on provision/refresh, do not edit by hand.\n` +
    body +
    '\n'
  );
}
// Write AFTER refreshLane's `git clean -fd` (which would otherwise remove this untracked file). `.env.local`
// is git-ignored so a lane never commits it.
function writeLaneEnv(repo, n) {
  const contents = laneEnvLocal(repo, n);
  if (contents === null) return;
  writeFileSync(join(laneDir(repo, n), '.env.local'), contents);
}

// ── constellation sibling clones for the WE pool (#2166 → #2282 → #2349) ─────────────────────────────
// Every WE grid page SSRs through the pinned FUI build-artifact, resolved by
// `scripts/lib/component-render-build-hook.cjs` at the FIXED relative path `../frontierui/dist/tools/
// component-render/cli.mjs` — i.e. a `frontierui` checkout SIBLING of the WE repo root. In the primary
// checkout that sibling is `~/workspace/frontierui`; but a lane clone lives at `<poolDir>/lane-N`, whose
// parent (`<poolDir>`) has no `frontierui` — so `build:docs` / `eleventy --serve` / any rendered
// verification HARD-FAILS in a solo/interactive WE lane ("pinned FUI artifact missing"). The #1943
// orchestrator only provisions per-repo pools for items whose *impl* spans FUI; this render dependency is
// UNCONDITIONAL (independent of whether the edited item touches FUI), so it can't be gated behind that
// affected-repo detection — the pool itself must carry the sibling. A plain `plateau-app` sibling similarly
// un-breaks a lane's Vite dev-panel import (`vite.config.mts` → `../plateau-app/…`).
//
// Original fix (#2166): a SYMLINK at `<poolDir>/frontierui` to the primary checkout's real `frontierui`
// sibling. Ratified in #2282 (docs/agent/platform-decisions.md#pool-siblings-real-built-clones) and
// generalized here (#2349): the pool-root sibling is now a REAL, PUSHABLE git clone, not a symlink — one
// clone per sibling repo serves BOTH consumers at the same `../<name>` path a lane resolves — WE-lane
// render reads its BUILT `dist/`, and the drain's cross-repo rebase-drop (`merge-ai-prs.mjs`
// `siblingCloneDir`, unchanged — it already resolves `../<name>`) fetches/pushes its `origin`. Safe to
// share: rebase-drop is pure git plumbing (merge-tree → commit-tree → push, no checkout), so it only
// mutates git objects/refs — disjoint from render's `dist/` reads. The symlink's one lost behavior: render
// no longer reflects the primary checkout's uncommitted FUI WIP, only its committed `main` — freshness
// ownership moves to this provisioner, which rebuilds `dist/` (via the sibling's own `build:tools`, where
// it has one — frontierui does, plateau-app doesn't) on every provision/refresh.
//
// Idempotent: a clean, up-to-date clone is fetched + fast-forwarded + rebuilt (cheap — ~1.2s for FUI); a
// missing clone is created (`--reference` the primary sibling for fast local object-sharing, same pattern
// as `cloneLane`); a legacy pre-#2282 symlink is replaced with a real clone; a DIRTY or AHEAD clone (like a
// lane, #2267) is left untouched rather than reset-away, since it is now real, pushable, mutable state.
// Only the WE pool (identified by a PORT_BANDS entry — the same signal that marks the env-driven dev band)
// provisions siblings; other pools no-op. If the primary sibling is absent (no local checkout to derive an
// origin URL from) we WARN (not fail) — the pool is still usable for non-render work.
const SIBLING_REPO_NAMES = ['frontierui', 'plateau-app'];

function primarySiblingPath(repo, name) {
  // A sibling repo is the sibling of the PRIMARY WE checkout (the pool's reference repo), e.g.
  // ~/workspace/webeverything → ~/workspace/frontierui / ~/workspace/plateau-app.
  return join(dirname(repo.referencePath), name);
}

function siblingHasBuildTools(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return !!(pkg && pkg.scripts && pkg.scripts['build:tools']);
  } catch {
    return false;
  }
}

function buildSibling(dir, name) {
  if (!siblingHasBuildTools(dir)) return; // e.g. plateau-app — a plain clone is enough (#2282)
  // A sibling with a `build:tools` needs its OWN `node_modules` first: the clone is `--reference`d
  // (shared git objects, NOT node_modules) and FUI's build-tools.mjs statically `import esbuild` + runs
  // `npx tsc`, so on a fresh clone it throws ERR_MODULE_NOT_FOUND before it can emit `dist/`. Install deps
  // exactly as WE lanes do (idempotent via the .git deps marker → no reinstall on a warm refresh, #2349).
  try {
    ensureDeps(dir);
  } catch (e) {
    log(`  ⚠ ${name} sibling deps install failed — build:tools will likely fail too (${e.message})`);
  }
  log(`  building ${name} sibling (npm run build:tools) …`);
  try {
    execFileSync('npm', ['run', 'build:tools'], { cwd: dir, stdio: 'inherit' });
  } catch (e) {
    log(`  ⚠ ${name} sibling build:tools failed — WE-lane render may see a stale/missing dist/ (${e.message})`);
  }
}

function ensureOneSibling(repo, name, { force = false } = {}) {
  const dest = join(repo.poolDir, name);
  const primary = primarySiblingPath(repo, name);

  // Replace a pre-#2282 render-only symlink (or any other symlink) with a real clone.
  let existing = null;
  try {
    existing = lstatSync(dest);
  } catch {
    existing = null;
  }
  if (existing && existing.isSymbolicLink()) {
    rmSync(dest, { force: true });
    existing = null;
    log(`  replacing legacy ${dest} symlink with a real pushable clone (#2282)`);
  }

  if (existing && !existsSync(join(dest, '.git'))) {
    // A real dir/file squats the sibling path that isn't a git repo — don't clobber it.
    log(`  ⚠ ${dest} exists and is not a git clone — leaving it; ${name} sibling not (re)provisioned.`);
    return;
  }

  if (!existing) {
    const originUrl = existsSync(primary) ? tryGit(['remote', 'get-url', 'origin'], primary) : null;
    if (!originUrl) {
      log(
        `  ⚠ ${name} sibling source ${primary} not found/has no origin — WE lane build:docs/dev-serve or ` +
          `the drain's cross-repo rebase-drop will skip ${name} until it is present.`,
      );
      return;
    }
    const ref = cloneReferenceArgs(primary);
    log(`  clone ${name} sibling ← ${originUrl} ${ref.length ? `(--reference ${primary})` : '(no --reference: shallow)'} …`);
    try {
      gitQuiet(['clone', '--quiet', ...ref, originUrl, dest]);
    } catch (e) {
      // Unlike the old symlink (pure filesystem, no network), this is a real `git clone` of `originUrl` —
      // best-effort: a network blip / auth failure / moved remote must WARN and move on, not crash the
      // whole provision/refresh (which would otherwise abort AFTER every WE lane already succeeded, #2349).
      log(`  ⚠ ${name} sibling clone failed — WE lane build:docs/dev-serve or the drain's cross-repo ` + `rebase-drop will skip ${name} until it is provisioned (${e.message})`);
      rmSync(dest, { recursive: true, force: true }); // don't leave a partial/broken clone behind
      return;
    }
  }

  const branchRef = tryGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], dest);
  const branch = branchRef ? branchRef.replace(/^origin\//, '') : 'main';
  tryGit(['fetch', 'origin', '--prune', '--quiet'], dest);

  if (!force) {
    // #2267-style data-loss guard, now load-bearing here too: this clone is real & pushable (unlike the
    // #2166 symlink it replaces), so an unconditional reset/clean could destroy in-flight local state.
    const { dirty, ahead } = laneDirtyOrAhead(dest, branch);
    if (dirty || ahead > 0) {
      log(`  ${name} sibling: SKIPPED reset (dirty/ahead) — use --force to override; skipping rebuild too`);
      return;
    }
  }

  tryGit(['checkout', '--quiet', '-B', branch, `origin/${branch}`], dest);
  tryGit(['reset', '--hard', `origin/${branch}`, '--quiet'], dest);
  tryGit(['clean', '-fd', '--quiet'], dest);
  buildSibling(dest, name);
}

function ensureRepoSiblings(repo, opts = {}) {
  if (!PORT_BANDS[repo.name]) return; // not the WE pool → no unconditional sibling dependency
  for (const name of SIBLING_REPO_NAMES) ensureOneSibling(repo, name, opts);
}

// ── lane-ports registry (#2139) — item → lane page-port mapping for the main-checkout proxy ─────────
// The primary checkout's Vite server (vite.config.mts `lanePageProxy`) keeps `:3000` the single review
// URL by forwarding a lane-claimed item's `/backlog/<NNN>…/` page to the owning lane's dev server. The
// mapping lives in `.claude/lane-ports.json` in the PRIMARY checkout (the pool's reference repo): the
// dispatcher `map`s an item when it assigns it to a lane, and entries are cleared on `unmap`, lane
// `remove`, and `refresh` (a reset lane no longer renders the item). Only pools with a PORT_BANDS entry
// have page ports; `map` on a band-less pool fails loud.
const registryPath = (repo) => join(repo.referencePath, '.claude', 'lane-ports.json');
function lanePagePort(repo, n) {
  const band = PORT_BANDS[repo.name];
  if (!band) return null;
  const [, base] = Object.entries(band)[0]; // first band key is the repo's front-door (Vite) port
  return base + 100 + n * 10;
}
function readPortRegistry(repo) {
  const file = registryPath(repo);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function writePortRegistry(repo, entries) {
  const file = registryPath(repo);
  mkdirSync(join(repo.referencePath, '.claude'), { recursive: true });
  writeFileSync(file, JSON.stringify(entries, null, 2) + '\n');
}
function unmapLanes(repo, lanes) {
  const entries = readPortRegistry(repo);
  const dropped = Object.keys(entries).filter((num) => lanes.includes(entries[num].lane));
  if (dropped.length === 0) return;
  for (const num of dropped) delete entries[num];
  writePortRegistry(repo, entries);
  log(`  unmapped item(s) ${dropped.join(', ')} (lane ${lanes.join(', ')}) from ${registryPath(repo)}`);
}

// #2616 — the SHARED registry writer both `map` (the #2139 review-proxy) and acquire-time population use: record
// item(s) → this lane in the PRIMARY checkout's lane-ports registry. `port` is the lane's page-port when the pool
// has a PORT_BANDS entry (what the #2139 proxy forwards on); it is OMITTED for a band-less pool, because the #2616
// health-stall scan reverse-derives lane→num from `{ lane }` alone and needs no port. Each item id is normalized
// so the key matches the `#num` forms conveyor-state's `itemNumFromRef` / transcript scan recognize: a numeric run
// via `String(Number())` (drops leading zeros); a JIT `x…` slug LOWER-CASED (the scan's `#num` match is
// case-sensitive and generated slugs are lowercase, so an upper/mixed-case `--item` must fold to lowercase or it
// would key an entry no transcript ever matches). Returns the resolved port (or null) for the caller's log line.
function registerItemsToLane(repo, n, items) {
  const port = lanePagePort(repo, n);
  const entries = readPortRegistry(repo);
  for (const raw of items) {
    const key = /^\d+$/.test(raw) ? String(Number(raw)) : raw.toLowerCase();
    entries[key] = port === null ? { lane: n, repo: repo.name } : { port, lane: n, repo: repo.name };
  }
  writePortRegistry(repo, entries);
  return port;
}

// Lane indices on disk under a pool DIR, sorted by index (the primitive both the repo-scoped `existingLanes`
// and the #2667 cross-pool sweep share, so "what counts as a lane" is defined in exactly one place).
function laneIndicesIn(poolDir) {
  if (!existsSync(poolDir)) return [];
  return execFileSync('ls', ['-1', poolDir], { encoding: 'utf8' })
    .split('\n')
    .map((d) => d.trim())
    .filter((d) => /^lane-\d+$/.test(d))
    .map((d) => Number(d.slice(5)))
    .sort((a, b) => a - b);
}

// Lanes currently on disk for a repo's pool, sorted by index.
function existingLanes(repo) {
  return laneIndicesIn(repo.poolDir);
}

// #2667 — pool NAMES under POOL_ROOT that actually hold lanes (have at least one `lane-N` child). Skips the
// one-off scratch clones that also live under POOL_ROOT (drain / heal / pipeline checkouts) and the
// constellation sibling clones (`frontierui` / `plateau-app` render siblings) — none of those have `lane-N`
// children, so they never match. This is the set the cross-pool release-by-session sweep walks.
function existingPools() {
  if (!existsSync(POOL_ROOT)) return [];
  return execFileSync('ls', ['-1', POOL_ROOT], { encoding: 'utf8' })
    .split('\n')
    .map((d) => d.trim())
    .filter(Boolean)
    .filter((name) => laneIndicesIn(join(POOL_ROOT, name)).length > 0)
    .sort();
}

// ── deps (node_modules) — not shared by --reference, so installed per lane on fresh-clone / lockfile change ──
const DEPS_MARKER = (dir) => join(dir, '.git', '.lane-pool-deps'); // inside .git ⇒ never tracked or git-cleaned
function lockHash(dir) {
  const lock = join(dir, 'package-lock.json');
  const pkg = join(dir, 'package.json');
  const file = existsSync(lock) ? lock : existsSync(pkg) ? pkg : null;
  if (!file) return null;
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
function depsReady(dir) {
  const want = lockHash(dir);
  if (want === null) return 'n/a'; // no package.json → nothing to install
  if (!existsSync(join(dir, 'node_modules'))) return 'missing';
  const have = existsSync(DEPS_MARKER(dir)) ? readFileSync(DEPS_MARKER(dir), 'utf8').trim() : null;
  return have === want ? 'ok' : 'stale';
}
function ensureDeps(dir) {
  const state = depsReady(dir);
  if (state === 'n/a' || state === 'ok') return state;
  const useCi = existsSync(join(dir, 'package-lock.json'));
  log(`  deps ${state} → npm ${useCi ? 'ci' : 'install'} in ${dir} …`);
  execFileSync('npm', [useCi ? 'ci' : 'install'], { cwd: dir, stdio: 'inherit' });
  writeFileSync(DEPS_MARKER(dir), lockHash(dir));
  return 'installed';
}

// ── lease (#2275) — an exclusive hold so a lane is never recycled or double-acquired while in use ─────
// The marker lives INSIDE `.git` (like DEPS_MARKER) so it is never tracked, never `git clean`-ed, and
// never seen by `git status --porcelain` (so it doesn't itself make a lane look dirty). A held lane is
// off-limits to `refresh`/`provision`'s `reset --hard` AND to another session's `acquire`, until `release`
// (or TTL-reclaim). See scripts/lib/lane-lease.mjs for the pure decision logic.
const LEASE_MARKER = (dir) => join(dir, '.git', LEASE_FILENAME);
function readLease(dir) {
  const file = LEASE_MARKER(dir);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null; // a corrupt marker is treated as no live lease (isLeaseStale also fails-open)
  }
}
const ttlMinutesFromFlags = () =>
  flags['ttl-minutes'] !== undefined && Number.isFinite(Number(flags['ttl-minutes']))
    ? Number(flags['ttl-minutes'])
    : DEFAULT_LEASE_TTL_MINUTES;
const ttlMsFromFlags = () => ttlMinutesFromFlags() * 60_000;
// A lane holds a LIVE lease when a marker exists and hasn't outlived its TTL (owner presumed alive).
function liveLease(dir, nowMs, ttlMs) {
  const lease = readLease(dir);
  return lease && !isLeaseStale(lease, nowMs, ttlMs) ? lease : null;
}
// #2997 — every OTHER lane's LIVE lease the caller could be confused with. The input to `isContestedLease`,
// i.e. "is a sibling agent of this lease's session holding a lane right now?". Best-effort: any read failure
// just yields a shorter list, which can only make a lease read as UNcontested (today's behaviour) — never a
// spurious refusal.
// #2997 r2 (review F3) — the scan is CROSS-POOL, not this pool only. A session's sibling agents routinely hold
// lanes in different pools (a cross-locus couple leases one lane in the web-everything pool and one in the
// plateau-app pool), and a same-pool-only scan read those as uncontested — the ambient id is exactly as
// ambiguous there, so the refusal must arm there too. The cost is a readdir per pool, paid only on release.
function liveLeasesInPoolExcept(repo, lane, nowMs, ttlMs) {
  const here = laneDir(repo, lane);
  const out = [];
  for (const name of existingPools()) {
    const poolDir = join(POOL_ROOT, name);
    for (const n of laneIndicesIn(poolDir)) {
      const dir = join(poolDir, `lane-${n}`);
      if (dir === here) continue; // never the subject lane itself
      const lease = liveLease(dir, nowMs, ttlMs);
      if (lease) out.push(lease);
    }
  }
  return out;
}
// Session identity must be STABLE across a consumer's separate `acquire` then `release` invocations, yet
// DISTINCT between concurrent sessions on one host (the whole point — session B must not release session A's
// lane). A per-process pid is unstable (each CLI call is a new pid); a bare hostname collides across
// sessions. So: an explicit `--session` (what every flow should pass) wins; else `LANE_SESSION` env; else
// the parent shell's pid (`ppid` — the same shell drives a flow's acquire+release, and differs per session).
const defaultSession = () => flags.session || process.env.LANE_SESSION || `${hostname()}:${process.ppid}`;

// #2997 — mint the PER-HOLDER slug stamped into every lease's `holder` field. This is the ownership signal that
// `ownerSession` structurally cannot be: two sibling agents of one session inherit the SAME
// `CLAUDE_CODE_SESSION_ID` verbatim (#2413's ratified statute), so ANY ambient env/process property reads
// identically for both — which is exactly how a 2026-08-14 `release --lane=5` dropped a concurrent holder's
// lease. A random component is what makes the slug un-shareable by accident; it is handed to the acquirer (and
// only the acquirer) on stdout, so re-asserting it is proof of holding, not of belonging to the session.
// Shaped `<purpose>-<lane>-<rand>` so a human/agent reading a deny message can tell whose it is, and restricted
// to `assertedLaneSlug`'s charset so it survives an inline `LANE_SESSION=<slug>` assertion unchanged.
function mintHolderSlug(dir, purpose) {
  const tag = String(purpose || 'lane').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'lane';
  return `${tag}-${basename(dir)}-${randomBytes(4).toString('hex')}`;
}

// ── core ops ──────────────────────────────────────────────────────────────────────────────────────
function cloneLane(repo, n) {
  const dest = laneDir(repo, n);
  // #2667 — `--pool=<name>` makes a null origin non-fatal at resolve (for read/release ops), so a CLONE path
  // must fail CLEANLY here rather than passing null to `git clone` (a raw TypeError). --pool selects an EXISTING
  // pool for read/release; to clone/acquire a new lane, pass --repo or --origin so an origin URL is derivable.
  if (!repo.originUrl) {
    fail(`could not determine an origin URL for pool "${repo.name}" — --pool selects an existing pool for read/release only; to clone/acquire a lane pass --repo=<checkout> or --origin=<url>`);
  }
  const ref = cloneReferenceArgs(repo.referencePath);
  log(`  clone lane-${n} ← ${repo.originUrl} ${ref.length ? `(--reference ${repo.referencePath})` : '(no --reference: shallow)'} …`);
  gitQuiet(['clone', '--quiet', ...ref, repo.originUrl, dest]);
  // Pin a stable local default branch so refresh's hard-reset target is unambiguous.
  tryGit(['checkout', '--quiet', '-B', repo.branch, `origin/${repo.branch}`], dest);
}

// Dirty-or-ahead guard (#2267 — data-loss guard): a lane's ONLY durable state is what has already been
// PUSHED to origin (i.e. landed via pr-land); anything else (uncommitted edits, or commits made locally
// but not yet pushed to its `lane/*` ref) lives nowhere else and is destroyed by `reset --hard` + `clean
// -fd`. Compute this AFTER the fetch (so "ahead" reflects the latest origin/<branch>) but BEFORE any
// destructive git call.
function laneDirtyOrAhead(dir, branch) {
  const porcelain = tryGit(['status', '--porcelain'], dir);
  const uncommitted = porcelain ? porcelain.split('\n').filter(Boolean).length : 0;
  const aheadRaw = tryGit(['rev-list', '--count', `origin/${branch}..HEAD`], dir);
  const ahead = aheadRaw === null ? 0 : Number(aheadRaw);
  // #2452 review — this predicate reports the FACT only ("how many commits ahead of the local origin ref").
  // The Gap-1 relaxation used to live here, which silently changed reset/skip semantics for every caller
  // (`refreshLane`'s hard-reset decision, `status`, the board) even though it is justified only for acquire's
  // auto-pick. Policy now lives at that one call site — see `aheadIsProvablyPushed`.
  return { dirty: uncommitted > 0, uncommitted, ahead };
}

/**
 * #2452 (Gap 1, hardened in review) — is this lane's HEAD PROVABLY already on origin, so acquire's auto-pick
 * may treat an "ahead" lane as recyclable rather than firing the #2267 never-recycle-unpushed-work guard?
 *
 * The first cut answered this from LOCAL remote-tracking refs alone (`for-each-ref --contains=HEAD
 * refs/remotes`). That is unsound: a local `refs/remotes/origin/lane/*` ref is exactly as stale as the
 * `origin/<branch>` ref the check exists to distrust. A `lane/*` branch deleted on origin after landing (the
 * normal end of a lane's life) leaves its remote-tracking ref behind locally, so HEAD still "contains" into
 * it and the guard clears — handing a hard `reset --hard` to a lane whose commits exist NOWHERE on the
 * remote. The failure mode of a wrong answer here is destroyed work, so it must be checked against the live
 * remote, not a cache.
 *
 * `remoteShas` is the live `ls-remote` snapshot (taken ONCE per acquire pass, and only when some lane looks
 * ahead — so the no-per-lane-fetch cost profile is preserved in the common case). HEAD counts as pushed only
 * if it is a live remote tip or an ancestor of one. Fails CLOSED on any git fault: no proof ⇒ stay protected.
 *
 * #2920 — this used to be a per-remote-head `merge-base --is-ancestor` fan-out (one spawn per live remote
 * head, per ahead lane): on the real 38-lane pool with 29 remote heads that was 677 git spawns / ~30s for
 * one acquire pass. Containment is answerable in ONE spawn: `rev-list HEAD --not <shas...>` walks HEAD's
 * ancestry once, excluding everything reachable from ANY of the given shas — empty output means HEAD (and
 * everything under it) is already reachable from some remote head, i.e. exactly the OR-across-heads the old
 * loop computed. `--ignore-missing` tolerates a remoteShas entry whose object isn't present in this lane's
 * local object DB (e.g. a branch this lane never fetched) by dropping it from the exclusion set rather than
 * failing the whole spawn — the same fail-open-per-candidate behavior the old per-sha loop had (a missing
 * object just couldn't prove anything, but didn't stop OTHER candidates from proving it). Verified against
 * the live pool + synthetic cases (fully pushed / one unpushed commit / deleted remote ref / detached HEAD /
 * no remotes / empty repo / unresolvable sha mixed with a valid one) — zero verdict flips vs. the old loop.
 */
function aheadIsProvablyPushed(dir, remoteShas) {
  if (!remoteShas || remoteShas.size === 0) return false;
  const headRaw = tryGit(['rev-parse', 'HEAD'], dir);
  if (!headRaw) return false;
  const head = headRaw.trim();
  if (remoteShas.has(head)) return true;
  const out = tryGit(['rev-list', '--ignore-missing', '--max-count=1', 'HEAD', '--not', ...remoteShas], dir);
  return out !== null && out.trim() === '';
}

/** Live remote tip SHAs (one network call, `timeout` guarded like the adjacent `gh` call — #2920). Returns
 *  an EMPTY set on any failure/timeout, so callers fail closed. */
function liveRemoteShas(dir) {
  const out = tryGit(['ls-remote', '--heads', 'origin'], dir, { timeout: 8000 });
  if (out === null) return new Set();
  return new Set(out.split('\n').filter(Boolean).map((l) => l.split(/\s+/)[0]).filter(Boolean));
}

// Returns { skipped: boolean, dirty, uncommitted, ahead } so callers can tell an actually-reset lane
// (safe to unmap its stale item mapping, #2139) from a skipped one (still serving its in-flight item).
function refreshLane(repo, n, { force = false } = {}) {
  const dir = laneDir(repo, n);
  fetchOriginPruneWithRetry(dir);
  // #2337(b) — a LIVE lease is an ownership hold (a process is presumed alive within TTL), distinct from the
  // dirty/ahead STALENESS guard below. `--force` exists to recycle stale residue, not to stomp an active
  // consumer, so the lease check runs REGARDLESS of `--force`: a leased lane is always skipped (loud), never
  // reset. The deliberate override is `release --force` (drop the lease), not this flag.
  const lease = liveLease(dir, Date.now(), ttlMsFromFlags());
  if (lease) {
    // #2350 — a RESERVED (permanent) lane is skipped forever; the un-reserve is `release --release-reserved`,
    // never `release --force` (which drops an ordinary hold but leaves a reserved one in place).
    const escape = isReservedLease(lease)
      ? `a PERMANENT reserved lane; --force never resets it (#2350); use \`release --lane=${n} --release-reserved\` to deliberately un-reserve`
      : `LIVE lease; --force does not override it (#2337); use \`release --lane=${n} --force\` first`;
    log(`  lane-${n}: SKIPPED (${describeLease(lease)}) — ${escape}`);
    return { skipped: true, leased: true, dirty: false, uncommitted: 0, ahead: 0 };
  }
  if (!force) {
    // #2267 — dirty/ahead is a property of the TREE (possibly abandoned residue from a dead session), which
    // `--force` exists to recycle. Skippable by `--force`, unlike the lease check above.
    const { dirty, uncommitted, ahead } = laneDirtyOrAhead(dir, repo.branch);
    if (dirty || ahead > 0) {
      log(`  lane-${n}: SKIPPED (dirty/ahead — ${uncommitted} uncommitted, ${ahead} ahead) — use --force to override`);
      return { skipped: true, dirty, uncommitted, ahead };
    }
  }
  git(['reset', '--hard', `origin/${repo.branch}`, '--quiet'], dir);
  git(['clean', '-fd', '--quiet'], dir); // remove untracked, KEEP ignored (node_modules) — no -x
  return { skipped: false, dirty: false, uncommitted: 0, ahead: 0 };
}

function laneStatus(repo, n) {
  const dir = laneDir(repo, n);
  if (!existsSync(dir)) return { lane: n, path: dir, exists: false };
  const head = tryGit(['rev-parse', '--short', 'HEAD'], dir);
  const branch = tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
  const porcelain = tryGit(['status', '--porcelain'], dir);
  const behind = tryGit(['rev-list', '--count', `HEAD..origin/${repo.branch}`], dir);
  const lease = readLease(dir);
  return {
    lane: n,
    path: dir,
    exists: true,
    head,
    branch,
    clean: porcelain === '',
    behind: behind === null ? '?' : Number(behind),
    deps: depsReady(dir),
    // #2275 — surface the hold so a picker can filter (and a human sees who owns a lane). `leased` is only
    // true for a LIVE lease; a stale marker reads as free (reclaimable), matching acquire's own logic.
    lease: lease || null,
    leased: lease ? !isLeaseStale(lease, Date.now(), ttlMsFromFlags()) : false,
  };
}

// #2426 — the lease/dirty snapshot a lease-aware picker (`list --acquirable`, `provision --acquirable`) needs to
// decide whether a lane is safe to couple an item onto. Shape matches `isLaneAcquirable(info, now, ttl)` in
// lane-lease.mjs: `exists`, the raw `lease` marker, and `dirtyOrAhead` (someone's un-pushed work). It reads the
// LOCAL `origin/<branch>` ref (no fetch — a cheap snapshot; a stale-looking "ahead" only fails safe by skipping).
function laneAcquirableInfo(repo, n) {
  const dir = laneDir(repo, n);
  if (!existsSync(dir)) return { lane: n, exists: false };
  return { lane: n, exists: true, lease: readLease(dir), dirtyOrAhead: laneDirtyOrAhead(dir, repo.branch) };
}

// ── output ──────────────────────────────────────────────────────────────────────────────────────────
const log = (m) => process.stderr.write(m + '\n');
function fail(m) {
  process.stderr.write(`✗ ${m}\n`);
  process.exit(1);
}

// ── commands ──────────────────────────────────────────────────────────────────────────────────────
// Provision one lane (clone if missing, refresh, write env, ensure deps). Returns refreshLane's result so the
// caller can tell an actually-reset lane (safe to unmap its stale item mapping) from a skipped/leased one.
function provisionLane(repo, n, force) {
  if (!existsSync(laneDir(repo, n))) cloneLane(repo, n);
  else log(`  lane-${n} exists`);
  const result = refreshLane(repo, n, { force });
  writeLaneEnv(repo, n);
  if (!flags['no-install']) ensureDeps(laneDir(repo, n));
  return result;
}

// #2426 — headroom past --count when growing to N ACQUIRABLE lanes, so a run with many foreign-leased lanes can
// still cover N usable ones without cloning unboundedly (a corrupt lease that never reads acquirable would loop).
const ACQUIRABLE_PROVISION_HEADROOM = 32;

function cmdProvision(repo) {
  const count = Number(flags.count);
  if (!Number.isInteger(count) || count < 1) fail('provision needs --count=<positive integer>');
  mkdirSync(repo.poolDir, { recursive: true });
  const force = !!flags.force;
  const resetLanes = []; // only lanes actually reset lose their stale mapping — a skipped lane still serves it

  // #2426 — `--acquirable` provisions until `count` lanes are ACQUIRABLE (not foreign-leased / busy), growing the
  // pool PAST held lanes rather than stopping at lane-<count>. This is what lets the parallel /workflow couple N
  // items to N usable lanes even when a sibling session holds some of the low-index ones: without it, provision
  // clones lane-1..N, a leased lane among them is skipped (correctly, never clobbered) but still occupies a
  // coupling slot, so its item is carried with zero work.
  if (flags.acquirable) {
    const nowMs = Date.now();
    const ttlMs = ttlMsFromFlags();
    const cap = count + ACQUIRABLE_PROVISION_HEADROOM;
    log(`provisioning up to ${count} ACQUIRABLE lane(s) for "${repo.name}" under ${repo.poolDir} (branch ${repo.branch}; cap lane-${cap})`);
    let acquirable = 0;
    let n = 0;
    while (acquirable < count && n < cap) {
      n++;
      const result = provisionLane(repo, n, force);
      if (!result.skipped) resetLanes.push(n);
      if (isLaneAcquirable(laneAcquirableInfo(repo, n), nowMs, ttlMs)) acquirable++;
    }
    if (acquirable < count) {
      log(`⚠ only ${acquirable}/${count} lane(s) acquirable after provisioning through lane-${n} (rest hold a foreign lease / un-pushed work) — the orchestrator will log the contention and carry the overflow, never double up a lane.`);
    } else {
      log(`ensured ${count} acquirable lane(s) (provisioned through lane-${n}; skipped foreign-leased/busy lanes)`);
    }
  } else {
    log(`provisioning ${count} lane(s) for "${repo.name}" under ${repo.poolDir} (branch ${repo.branch})`);
    for (let n = 1; n <= count; n++) {
      const result = provisionLane(repo, n, force);
      if (!result.skipped) resetLanes.push(n);
    }
  }
  unmapLanes(repo, resetLanes); // refreshed lanes lose stale mappings (#2139); skipped lanes keep theirs
  ensureRepoSiblings(repo, { force }); // pushable+built constellation siblings at the pool root (#2166/#2282/#2349)
  printStatus(repo);
}

function cmdRefresh(repo) {
  const lanes = existingLanes(repo);
  if (lanes.length === 0) fail(`no lanes to refresh under ${repo.poolDir} (run provision first)`);
  log(`refreshing ${lanes.length} lane(s) for "${repo.name}" → origin/${repo.branch}`);
  const force = !!flags.force;
  const resetLanes = []; // only lanes actually reset lose their stale mapping — a skipped lane still serves it
  for (const n of lanes) {
    const result = refreshLane(repo, n, { force });
    if (!result.skipped) resetLanes.push(n);
    writeLaneEnv(repo, n);
    if (!flags['no-install']) ensureDeps(laneDir(repo, n));
  }
  unmapLanes(repo, resetLanes); // a reset lane no longer renders its old item (#2139); a skipped one still does
  ensureRepoSiblings(repo, { force }); // keep the WE pool's constellation siblings current on refresh too
  printStatus(repo);
}

// ── acquire / release (#2275) — the exclusive-lease allocator any flow consumes ─────────────────────
// A consumer (`/drain`, `/merge`, `/batch`, solo `#2123`, `/prepare`, `/decision`) does:
//   export LANE_SESSION=<slug>                                                  # ties acquire↔release together
//   LANE=$(node scripts/lane-pool.mjs acquire --purpose=drain) && cd "$LANE"    # leased, reset to origin/main
//   …work, land its PR…
//   node scripts/lane-pool.mjs release --lane=<n>                              # hand it back to the pool
// The lease is what lets a use-agnostic pool lane safely stand in for the hand-rolled `../we-drain-clean`
// clone: held ⇒ refresh/provision won't reset it out from under the drain (item 2's "a lane may sit on main"
// is just the reset-to-origin/main state below, now protected by the hold).

// Try to claim a specific lane's marker atomically (O_EXCL). Returns the claim's minted HOLDER SLUG (a truthy
// string, #2997) iff THIS call created the marker, else null. A live lease owned by someone else ⇒ null (taken
// — #2337(b), NOT overridable by `--force`; the deliberate override is `release --force` then re-acquire, per
// the ruling's "no new flag" contract). A stale marker ⇒ reclaimed (rm + retry, the small documented race).
// Own live lease ⇒ claimed (idempotent re-acquire) — and that path PRESERVES the existing `holder` slug, so an
// idempotent re-acquire never invalidates the slug the current holder is already asserting.
function tryClaimLane(dir, session, nowMs, ttlMs) {
  // #2367 — stamp a DURABLE session identity (`CLAUDE_CODE_SESSION_ID`, exposed to this subprocess) so a later
  // guard can tell "my own lease" from another live session's AUTHORITATIVELY — it is stable across a session's
  // separate Bash-tool calls yet distinct between concurrent sessions, and does NOT false-match two independent
  // sessions that merely share an upper process ancestor (terminal / a parallel-lane orchestrator). This is the
  // SOLE ownership signal (r2 removed the pid-ancestry fallback, whose chain overlap over-matched exactly that
  // shared-ancestor topology and so failed open while looking protective — see `isForeignLease`, lane-lease.mjs).
  // `pid` stays as an informational-only field (human-readable `status`/debug), never used for ownership.
  const mintedHolder = mintHolderSlug(dir, flags.purpose);
  const bodyFor = (holder, workerSession) => JSON.stringify(
    leaseBody({
      session, purpose: flags.purpose, acquiredAt: new Date(nowMs).toISOString(), ttlMinutes: ttlMinutesFromFlags(),
      host: hostname(), pid: process.pid,
      ownerSession: process.env.CLAUDE_CODE_SESSION_ID || null,
      // #2997 — the minted PER-HOLDER slug, stamped on EVERY acquire rather than only on a `workflowLane` one.
      // #2413 built this exact channel but gated it on that marker, so every other concurrent topology (ad-hoc
      // subagents, the conveyor's `conveyor-*` dispatch) kept falling back to the `ownerSession` compare that
      // cannot separate siblings. Minting it universally is what lets the guards and `release` demand proof of
      // HOLDING (not merely of belonging to the same session) wherever that compare is provably ambiguous.
      holder,
      // #2997 r2 — the DECLARED OCCUPANT. `ownerSession` above records whoever RAN this acquire, which is the
      // DISPATCHER whenever a lane is leased on an agent's behalf — so it can never answer "who is working
      // here". `--adopt` is how the acquirer says "and I am the one who will work in it"; a dispatcher simply
      // omits it and the worker claims the lane later with `adopt --lane=N`. Omitted unless claimed.
      workerSession,
      // #2413 — `--purpose=workflow-lane` MARKS the lease: it stamps the dedicated `workflowLane: true` field
      // (not free-text purpose) that switches the destructive-op guard fail-closed for this lane, requiring a
      // sibling parallel lane to assert this lease's own minted `session` slug before it can clobber the clone.
      workflowLane: flags.purpose === WORKFLOW_LANE_PURPOSE,
      // #2560 — persist the ADVISORY predicted file-scope declared via `acquire --scope=` (omitted when empty,
      // so a scope-less acquire's marker is unchanged). This is the real predicted-scope source the live
      // scope-lease collector/observer reads; it NEVER gates the claim (the O_EXCL marker below is the lock).
      predictedScope: parseScopeFlag(flags.scope),
      // #2350 — `acquire --reserve` stamps a PERMANENT reserved lease: `isLeaseStale` short-circuits it to
      // never-stale, so refresh/provision (even --force) never reset it and auto-pick never couples onto it.
      reserved: !!flags.reserve,
    }),
    null, 2,
  ) + '\n';
  // #2997 r2 — `--adopt` means "I am also the agent that will WORK this lane", so stamp the occupant now. A
  // dispatcher acquiring on someone else's behalf omits it and the worker runs `adopt --lane=N` at hand-off.
  const adopted = flags.adopt ? (process.env.CLAUDE_CODE_SESSION_ID || null) : null;
  const file = LEASE_MARKER(dir);
  try {
    writeFileSync(file, bodyFor(mintedHolder, adopted), { flag: 'wx' }); // atomic create-or-fail — the race-free happy path
    return mintedHolder;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  const existing = readLease(dir);
  if (leaseOwnedBy(existing, session)) {
    // #2997 — an IDEMPOTENT re-acquire of our own hold KEEPS the existing `holder` slug. Re-minting here would
    // silently invalidate the slug the current holder is already asserting in its commands, turning its next
    // legitimate destructive op into a mismatch deny — a self-inflicted false refusal.
    const holder = laneHolderSlug(existing) || mintedHolder;
    // …and it KEEPS the declared occupant for the same reason: dropping it would silently un-protect a lane an
    // agent is working in. `--adopt` on the re-acquire is the deliberate way to (re-)claim it.
    writeFileSync(file, bodyFor(holder, adopted || laneWorkerSession(existing)));
    return holder;
  }
  if (isLeaseStale(existing, nowMs, ttlMs)) {
    rmSync(file, { force: true });                 // reclaim a stale lease (unlink→create race: acceptable)
    // A reclaim is a NEW hold by a NEW holder, so it mints a fresh slug — the dead owner's slug must not carry
    // over, or a returning zombie would still assert its way past the guard. The dead owner's declared
    // OCCUPANCY is dropped for the same reason (only `--adopt` re-declares it for the new holder).
    try { writeFileSync(file, bodyFor(mintedHolder, adopted), { flag: 'wx' }); return mintedHolder; } catch { return null; }
  }
  return null; // a LIVE lease held by another session — this lane is taken, even with --force
}

// #2748 — the acquire-native reaper pass. Reclaims a PROVABLY-DEAD lease in `repo`'s pool before a fresh
// acquire selects a lane. "Provably dead" = a POSITIVE death signal, never absence-of-activity (the #2267
// data-loss hazard): the lease's item PR is merged/closed (the live gh axis), OR the item card reads
// `status: resolved` on origin/main (the offline axis — resolution is MONOTONIC, so a stale local read only
// MISSES a reap, never wrongly reaps) — AND, #3283, the lease is TTL-stale, because a terminal signal about
// the ITEM says nothing about whether anyone is HOLDING the lane (see `signalsFor` below for the full why).
// The reap VERDICT is the standalone reaper's own pure `classifyReap`
// (via `reapPlan`), so this backstop and the periodic reaper can never disagree — and reserved (permanent
// memory) leases are excluded by `classifyReap` on every axis. TTL-stale reclamation is deliberately LEFT to
// acquire's existing path (`tryClaimLane` reclaims a >TTL lease for THIS session, unchanged) — this pass only
// acts on the NEW terminal axes, so it never changes TTL semantics. Everything is best-effort: a gh/git/fs
// hiccup degrades the axis and leaves the lease in place, never blocks the acquire. Returns the reaped indices.
function reapDeadLeasesInPool(repo, nowMs, ttlMs) {
  if (flags['no-reap']) return [];
  const candidates = [];
  for (const n of existingLanes(repo)) {
    const dir = laneDir(repo, n);
    const lease = readLease(dir);
    if (lease) candidates.push({ lane: n, dir, lease });
  }
  if (candidates.length === 0) return [];
  // PR-terminal axis (best-effort, one `gh pr list`): a merged/closed PR whose head ref `lane/<num>-*` maps
  // to a lease's item is a positive death signal. Degrades to OFF (null) if gh is absent / not a GitHub repo.
  let prStates = null;
  try {
    // `timeout` bounds the worst case: a slow/hung/unauthenticated gh must NEVER stall a dispatch acquire —
    // it degrades the PR axis to OFF (the offline item-resolved axis + TTL still apply), never blocks.
    const out = execFileSync('gh', ['pr', 'list', '--state', 'all', '--limit', '400', '--json', 'number,state,mergedAt,headRefName'], { cwd: repo.referencePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 });
    prStates = prStatesFromList(JSON.parse(out));
  } catch { prStates = null; }
  // Item-resolved axis (OFFLINE): read the pool's origin/<branch> backlog listing ONCE, then answer
  // "is item <num>'s card status:resolved?" frontmatter-strict. No fetch — a stale read is safe (monotonic).
  const backlogListing = (tryGit(['ls-tree', '-r', '--name-only', `origin/${repo.branch}`, '--', 'backlog/'], repo.referencePath) || '').split('\n').filter(Boolean);
  const itemResolvedOnMain = (num) => {
    if (!num) return false;
    const path = backlogListing.find((p) => new RegExp(`^backlog/0*${num}-`).test(p));
    if (!path) return false;
    const body = tryGit(['show', `origin/${repo.branch}:${path}`], repo.referencePath);
    return body != null && readField(body, 'status') === 'resolved';
  };
  const signalsFor = (c) => {
    const num = itemNumFromSession(c.lease?.session);
    // #3283 — A TERMINAL SIGNAL ABOUT THE ITEM IS NECESSARY BUT NOT SUFFICIENT. "This lane's item is finished"
    // — its PR merged, or its card resolved on main — answers *is there unlanded work here?* It never answers
    // *is anyone holding this lease?*, and this pass used the first as a proxy for the second. The proxy is
    // sound only once the holder has exited; for every lease whose holder is still working it is simply wrong,
    // so a lane handed out SECONDS ago was reclaimed by the very next acquire — which then returned that same
    // lane. Concurrency collapsed to one lane, and where nothing downstream checks, two agents share a clone.
    //
    // So both axes below are gated on the lease itself looking dead. The one trustworthy liveness signal in
    // today's schema is TTL: `pid` records the short-lived `lane-pool acquire` CLI, not the delivery agent
    // (an LLM has no unix pid — see `lease-reaper.pidAliveForLease`, still the plug-in point for a durable
    // `agentPid`), and `leaseOwnedByCaller` is string equality on every branch, an ownership proof and never
    // a liveness test. This NARROWS #2748 rather than undoing it: a TTL-stale lease whose item is terminal is
    // still reaped HERE, pre-TTL-reclaim and pool-wide, which is the ghost #2748 was built for.
    const holderPresumedGone = isLeaseStale(c.lease, nowMs, ttlMs);
    let prState = holderPresumedGone && prStates && num ? (prStates.get(num) ?? null) : null;
    // Item-resolved is a terminal death signal too — but NEVER override a live (open) PR, mirroring the
    // reaper's "open wins" safety (a same-number retry PR still in flight must not be reaped, #2267).
    if (holderPresumedGone && prState !== 'open' && prState !== 'merged' && prState !== 'closed' && itemResolvedOnMain(num)) prState = 'merged';
    return { prState, pidAlive: null }; // the pid axis is dormant under today's lease schema (see lease-reaper.pidAliveForLease)
  };
  const { reap } = reapPlan(candidates, { nowMs, ttlMs, signalsFor });
  const reaped = [];
  for (const c of reap) {
    // Only the NEW terminal axes here — leave 'ttl-stale' to acquire's existing reclaim path. 'reserved' can
    // never appear in `reap` (classifyReap short-circuits it), so no memory lane is ever collected.
    if (c.reason !== 'pr-merged' && c.reason !== 'pr-closed') continue;
    try {
      rmSync(LEASE_MARKER(c.dir), { force: true });
      unmapLanes(repo, [c.lane]); // a reaped ghost no longer renders its dead item (#2139)
      log(`  reaped lane-${c.lane} before acquire (${c.reason}; was ${describeLease(c.lease)}) — ghost lease reclaimed (#2748)`);
      reaped.push(c.lane);
    } catch { /* best-effort — a failed reclaim just leaves the lane held (acquire falls through to the next free lane) */ }
  }
  return reaped;
}

function cmdAcquire(repo) {
  // #2386 — `--base` and `--no-reset` are mutually exclusive: `--base=<ref>` means "reset this clone to <ref>",
  // and `--no-reset` skips the reset entirely. Honoring both would skip the reset yet still report the base as
  // applied (log line + JSON `base`), so an orchestrator stacking a serial batch would believe the lane sits on
  // the predecessor tip when HEAD was never moved. Reject the combo BEFORE claiming any lane (touches nothing) —
  // failing loud beats silently misreporting for a primitive other automation trusts.
  if (flags.base && flags['no-reset']) {
    fail(`--base=${flags.base} and --no-reset are mutually exclusive: --base resets the clone to that ref, which --no-reset would skip. Pass one or the other.`);
  }
  // #2350 — `--reserve` mints a PERMANENT reserved lane, which must be a SPECIFIC, known slot (the dedicated
  // memory-lane), never an auto-picked one — permanently reserving whichever lane happens to be free would be
  // a footgun. Require an explicit `--lane=N` (and a `--session` so the reserved hold has a stable, human-named
  // owner) before anything is claimed.
  if (flags.reserve && flags.lane === undefined) {
    fail('--reserve requires an explicit --lane=N (a permanent reserved lane is a specific, known slot — never auto-picked)');
  }
  const session = defaultSession();
  const nowMs = Date.now();
  const ttlMs = ttlMsFromFlags();
  // #2748 — REAPER BACKSTOP, native to acquire. BEFORE selecting a lane, reclaim any PROVABLY-DEAD ghost lease
  // in this pool — a lease whose item has merged/resolved, or whose PR is merged/closed — so a finished-but-
  // -unreleased lane (a dead agent's lingering lease that the drain's release-on-land could NOT clear, because
  // no land event ever fired for it) never blocks a fresh dispatch. This makes the pool ACT on the exact ghost
  // the conveyor board's health scan only FLAGS (#2616/#2700). Best-effort; `--no-reap` opts out (tests).
  reapDeadLeasesInPool(repo, nowMs, ttlMs);
  // #2560 — the ADVISORY predicted file-scope this acquire declares (empty when no `--scope`). Persisted into the
  // marker (via tryClaimLane) AND used for the strictly-non-blocking overlap warning below. It NEVER gates.
  const declaredScope = parseScopeFlag(flags.scope);
  const lanes = existingLanes(repo);
  if (lanes.length === 0) fail(`no lanes provisioned for "${repo.name}" — run \`provision --count=N\` first`);

  // Candidate infos from LOCAL refs (no per-lane fetch): `dirty` is live (working tree), `ahead` is vs the
  // last-known origin — conservative (over-protects an ahead lane). We fetch+reset only the winner.
  // #2452 (Gap 1) — the live-remote snapshot backing `aheadIsProvablyPushed`, taken LAZILY: only the first
  // lane that actually looks ahead pays the single `ls-remote`, so a pool with no ahead lanes still makes
  // zero network calls (the no-per-lane-fetch property this design is built around).
  let remoteShas = null;
  const infoFor = (n) => {
    const dir = laneDir(repo, n);
    if (!existsSync(dir)) return { lane: n, exists: false };
    const raw = laneDirtyOrAhead(dir, repo.branch);
    let dirtyOrAhead = raw;
    if (raw.ahead > 0) {
      // Only HERE (acquire's auto-pick) may a provably-pushed "ahead" lane be treated as recyclable —
      // `refreshLane`/`status` keep reading the raw fact. Fails closed: unproven ⇒ stays protected (#2267).
      if (remoteShas === null) remoteShas = liveRemoteShas(dir);
      if (aheadIsProvablyPushed(dir, remoteShas)) dirtyOrAhead = { ...raw, ahead: 0, aheadPushed: true };
    }
    return { lane: n, exists: true, dirtyOrAhead, lease: readLease(dir) };
  };

  let chosen = null;
  // #2350 — was the explicitly-targeted lane ALREADY reserved before this acquire? Captured pre-claim so the
  // reset path below can be skipped for an idempotent re-reserve (never `reset --hard` an already-populated
  // memory lane out from under itself).
  let targetWasReserved = false;
  // #2997 — the per-holder slug this acquire minted, reported back to the acquirer below. It is the ONLY thing
  // that distinguishes this holder from a sibling agent of the same session, so the acquirer must receive it.
  let holderSlug = null;
  if (flags.lane !== undefined) {
    // Explicit lane: honor it or fail loudly (don't silently divert to another).
    const n = Number(flags.lane);
    const dir = laneDir(repo, n);
    if (!existsSync(dir)) fail(`lane-${n} does not exist (${dir})`);
    // #2350 — a RESERVED lane is off-limits to an ordinary acquire, INCLUDING the OWNING session's own plain
    // re-acquire. Without this pre-claim guard, `tryClaimLane`'s `leaseOwnedBy` self-refresh would rewrite the
    // marker as an ordinary (non-reserved) lease and then the reset path below would `reset --hard` the lane —
    // silently un-reserving it and WIPING the memory it exists to hold (the exact footgun #2350 prevents).
    // Only `--reserve` may touch a reserved lane (an idempotent re-reserve, which keeps `reserved:true`).
    const preExisting = readLease(dir);
    if (isReservedLease(preExisting)) {
      if (!flags.reserve) {
        fail(
          `lane-${n} holds a ${describeLease(preExisting)} lease — a PERMANENT reserved lane, off-limits to acquire. ` +
            `Un-reserve it first (\`release --lane=${n} --release-reserved\`) if you truly mean to reclaim it, or pick another lane.`,
        );
      }
      targetWasReserved = true; // an idempotent re-reserve — skip the reset so accrued content survives
    }
    holderSlug = tryClaimLane(dir, session, nowMs, ttlMs);
    if (!holderSlug) {
      const lease = readLease(dir);
      // #2350 — a RESERVED (permanent) lane is off-limits to an ordinary acquire; point at the deliberate
      // un-reserve (`release --release-reserved`), NOT `release --force` (which never drops a reserved lease).
      if (isReservedLease(lease)) {
        fail(
          `lane-${n} holds a ${describeLease(lease)} lease — a PERMANENT reserved lane, off-limits to acquire. ` +
            `Un-reserve it first (\`release --lane=${n} --release-reserved\`) if you truly mean to reclaim it, or pick another lane.`,
        );
      }
      // #2337(b) — a LIVE lease hard-fails `acquire --lane=N --force` too (force never overrides a live
      // lease); point at the deliberate override (`release --force`) instead of implying --force helps.
      if (lease && !isLeaseStale(lease, nowMs, ttlMs)) {
        fail(
          `lane-${n} is ${describeLease(lease)} — a LIVE lease; --force does not override it (#2337). ` +
            `Release it first (\`release --lane=${n} --force\`), then acquire, or pick another lane.`,
        );
      }
      fail(`lane-${n} is ${describeLease(lease) || 'held'} — pick another lane`);
    }
    chosen = n;
  } else {
    // Auto-pick: lowest acquirable, then atomically claim; on a lost race retry the next candidate.
    const excluded = new Set();
    while (chosen === null) {
      const infos = lanes.filter((n) => !excluded.has(n)).map(infoFor);
      const pick = chooseFreeLane(infos, nowMs, ttlMs);
      if (pick === null) fail(`no free lane in pool "${repo.name}" (${lanes.length} all held/dirty) — release one or \`provision\` more`);
      const claimed = tryClaimLane(laneDir(repo, pick), session, nowMs, ttlMs);
      if (claimed) { chosen = pick; holderSlug = claimed; }
      else excluded.add(pick); // a concurrent acquire won this one — try the next
    }
  }

  // #2560 (§3i-A4 Fork 1) — ADVISORY, STRICTLY NON-BLOCKING scope-overlap check. Runs AFTER the atomic O_EXCL
  // claim above (the whole-clone lease is the REAL lock): this only WARNS to stderr if the declared scope
  // overlaps a sibling lane's predicted scope. It does NOT gate, block, delay, or change which lane won — the
  // lane is already claimed. Wrapped so a scope-check failure can NEVER throw into the acquire path.
  if (declaredScope.length) {
    const others = existingLanes(repo)
      .filter((n) => n !== chosen)
      .map((n) => ({ n, lease: liveLease(laneDir(repo, n), nowMs, ttlMs) }))
      .filter((x) => x.lease)
      .map((x) => ({ lane: x.n, predictedScope: x.lease.predictedScope ?? [], observedScope: [] }));
    try {
      const res = candidateLaunch({ candidateScope: declaredScope, leases: others });
      if (res.outcome !== 'launch') {
        log(`  ⚠ advisory (non-blocking): lane-${chosen} declared scope overlaps lane(s) ${res.waitOn?.length ? res.waitOn.join(', ') : '(see picture)'} — the whole-clone lease is the real lock; proceeding.`);
      }
    } catch { /* advisory only — never let a scope-check failure affect the acquire */ }
  }

  // Ready the leased lane: land on origin/<branch> (item 2 — a lane may sit on main), regen env + deps so it
  // is immediately gate-able, exactly like a provisioned lane. `--no-reset` keeps HEAD.
  // #2386 — `--base=<ref>` lands the clone at a PREDECESSOR LANE'S TIP instead, the building block for
  // overlap-stacked serial batches (a later lane's work builds on an earlier lane's not-yet-merged commits).
  // Still a pool clone — this never touches the primary checkout (#2219/#104): the ref is resolved and reset
  // to INSIDE this lane's own clone, same as the origin/<branch> default path it replaces.
  // #2350 — an idempotent re-reserve (`acquire --reserve --lane=N` on an already-reserved lane) NEVER resets:
  // resetting would `reset --hard` + `clean -fd` the reserved lane's accrued content (the memory it holds).
  // A FIRST reserve of a not-yet-reserved lane still resets (clean-populate to origin/main), like any acquire.
  const dir = laneDir(repo, chosen);
  if (!flags['no-reset'] && !targetWasReserved) {
    fetchOriginPruneWithRetry(dir);
    const baseRef = flags.base ? resolveBaseRef(dir, flags.base, chosen) : `origin/${repo.branch}`;
    // #2419 — `checkout -B <branch> <baseRef>`, NOT `reset --hard <baseRef>`. A bare reset moves whatever
    // branch HEAD happens to be attached to (it does not touch which branch that is), so a lane left
    // attached to a STRAY `lane/*` tip (a leftover from an earlier rebase-drop or a manual checkout — #2419's
    // primary cause) stayed attached to that stray branch forever after, just with fresher content. Every
    // downstream reader that assumes a lane sits on `repo.branch` (e.g. the drain's post-land `pull --ff-only`,
    // which needs an attached branch WITH an upstream) then silently no-ops or numbers off the wrong parent.
    // `checkout -B` creates-or-resets `repo.branch` (e.g. `main`) to `baseRef` AND checks it out in the same
    // atomic step, so every reset/acquire always leaves the lane on its own well-known local branch — never a
    // stray one — closing the strand at its source rather than only papering over it downstream. `--force` is
    // REQUIRED here (pre-PR review catch, #2419): unlike `reset --hard`, a bare `checkout -B` still runs the
    // ordinary safe-checkout tree-merge and REFUSES ("local changes would be overwritten by checkout") on a
    // dirty tracked-file conflict — reproduced live against a scratch repo. `acquire` has never gated this
    // reset on tree cleanliness (unlike `refreshLane`'s explicit `laneDirtyOrAhead` guard) — it must
    // unconditionally reclaim a lane regardless of stray edits left by a prior crashed/interrupted session, so
    // `--force` restores that same never-refuses guarantee `reset --hard` always gave it.
    git(['checkout', '-B', repo.branch, baseRef, '--quiet', '--force'], dir);
    git(['clean', '-fd', '--quiet'], dir);
    unmapLanes(repo, [chosen]); // a reset lane no longer renders its old item (#2139)
  }
  writeLaneEnv(repo, chosen);
  if (!flags['no-install']) ensureDeps(dir);
  // #2616 — record this lane's item → lane mapping in the PRIMARY checkout's lane-ports registry (the SAME
  // registry #2139's `map` writes and conveyor-state's health-stall scan reverse-derives lane→num from). A
  // conveyor delivery agent acquires its OWN lane and claims its OWN item, so nothing else calls `map` for it —
  // without this the registry stays `{}`, no lane carries a num, and the stall scan is permanently INERT
  // (`assessHealth` always `ok`, a stalled lane never surfaced). Runs HERE, after the reset's
  // `unmapLanes(chosen)`, so the fresh entry is never immediately cleared; the pre-map `unmapLanes` drops any
  // stale item still pointing at this lane (needed on the `--no-reset` path, where the reset's unmap did not run)
  // so lane→num stays 1:1. A band-less pool records `{ lane }` (no page port) — all the health scan needs.
  // Wrapped so a registry-write hiccup can NEVER fail the acquire (advisory, like the scope-overlap check above),
  // and the map log rides stderr so `--json`-less stdout stays the clean lane path (the `LANE=$(…)` contract).
  if (flags.item !== undefined) {
    const items = String(flags.item)
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s) || /^x[a-z0-9]{5,7}$/i.test(s));
    if (items.length) {
      try {
        unmapLanes(repo, [chosen]); // drop any stale item→this-lane entry first (a no-op right after a reset unmap)
        registerItemsToLane(repo, chosen, items);
        log(`  mapped item(s) ${items.join(', ')} → lane-${chosen} in ${registryPath(repo)} (#2616 health-stall map)`);
      } catch (e) {
        log(`  ⚠ could not record item→lane map (#2616) — the health-stall scan may stay inert for lane-${chosen} (${e.message})`);
      }
    }
  }
  // NOTE: do NOT re-run ensureRepoSiblings here. It resolves each sibling's primary from the *reference*
  // checkout's parent — correct only when run from the primary; run from INSIDE a lane (a consumer's cwd) it
  // mis-points the shared pool-root sibling clones at itself. The pool-root siblings are a provision/refresh
  // concern; a leased lane borrows a pool those already set up. (Regressed a live acquire until caught — #2275.)
  log(`${flags.reserve ? 'RESERVED' : 'acquired'} lane-${chosen} for ${session}${flags.purpose ? ` (${flags.purpose})` : ''}${flags.base ? ` @ base=${flags.base}` : ''}${flags.reserve ? ' — PERMANENT, off-limits to acquire/refresh/provision (#2350)' : ''} → ${dir}`);
  // #2997 — hand the acquirer its minted holder slug. This is the one signal that separates THIS holder from a
  // sibling agent of the same session, so it must reach the acquirer and nowhere else. It is needed only in the
  // CONTESTED topology (another live lease shares this session id), which is exactly when the guards and
  // `release` ask for it — hence "keep it if a sibling is live", not "prefix everything from now on".
  // Rides stderr (`log`) so `--json`-less stdout stays the clean lane path the `LANE=$(…)` contract depends on.
  log(`  holder slug: ${holderSlug} — if a SIBLING agent of your session also holds a lane, prove this one is yours:`);
  log(`    release:        node scripts/lane-pool.mjs release --lane=${chosen} --session=${holderSlug}`);
  log(`    destructive op: LANE_SESSION=${holderSlug} git reset --hard origin/${repo.branch}`);
  // #2997 r2 — OCCUPANCY is a separate declaration from the lease, because `ownerSession` records whoever ran
  // THIS process, which for a dispatched lane is not the agent that will work in it. Say so at the seam.
  const occupant = laneWorkerSession(readLease(dir));
  if (occupant) log(`  occupant: ${occupant} (--adopt) — Edit/Write from any OTHER session is now refused (#2997)`);
  else log(`  occupant: NOT declared — hand this lane off with \`node scripts/lane-pool.mjs adopt --lane=${chosen}\` run BY the agent that will work in it (or re-run acquire with --adopt if that is you); until then the Edit/Write guard stays fail-open for this lane`);
  if (flags.json) process.stdout.write(JSON.stringify({ lane: chosen, path: dir, session, holder: holderSlug, workerSession: occupant, purpose: flags.purpose || null, branch: repo.branch, base: flags.base || null, reserved: !!flags.reserve }, null, 2) + '\n');
  else process.stdout.write(dir + '\n'); // stdout = path only, so `LANE=$(… acquire)` captures it clean
}

// #2386 — resolve `--base=<ref>` inside a lane's own clone, AFTER its `fetch origin` so a predecessor lane's
// pushed `lane/*` tip is visible as `origin/<ref>`. Tries `origin/<ref>` FIRST — this is the freshly-fetched,
// authoritative source for "a predecessor lane's PUSHED tip" — falling back to the ref as literally given only
// if that doesn't resolve (a raw SHA, or a ref the caller already fully qualified, e.g. `origin/lane/…`).
// Order matters: trying the bare ref first would resolve `--base=main` to THIS LANE'S OWN stale local `main`
// branch (wherever it was left by the last reset, e.g. a prior `--base` acquire) instead of the origin tip this
// `fetch` just pulled — `fetch` only updates remote-tracking refs, never a checked-out local branch of the same
// name, so a same-named local ref silently shadowing the fresh origin one would be a hard-to-notice stale-data
// bug, not a loud failure. Caught live: acquiring with `--base=main` after origin/main advanced past the lane's
// last reset returned the OLD content with no error until this ordering was flipped.
function resolveBaseRef(dir, ref, laneNum) {
  const withOrigin = `origin/${ref}`;
  if (tryGit(['rev-parse', '--verify', '--quiet', withOrigin], dir)) return withOrigin;
  if (tryGit(['rev-parse', '--verify', '--quiet', ref], dir)) return ref;
  fail(
    `--base=${ref} does not resolve in lane-${laneNum}'s clone (tried "${withOrigin}" and "${ref}") — ` +
      `push it to origin first (a local-only ref on another checkout is not visible here), or pass a ref ` +
      `that already exists on origin.`,
  );
}

// #2350 (review:changes on #745) — `--release-reserved` is the ONE deliberate un-reserve, and it is
// single-lane BY CONTRACT: un-reserving (or removing) the memory lane is a specific, named act, never a side
// effect of a bulk `--all` sweep. Reject the combination so `release --all --release-reserved` (and, with the
// remove-guard escape hatch, `remove --all --release-reserved`) can never set `bypassOwnership` for EVERY
// reserved lease and silently drop the memory lane — require an explicit single `--lane=N`.
function assertReleaseReservedScoped() {
  if (flags['release-reserved'] && flags.all) {
    fail('--release-reserved may not be combined with --all — it is the deliberate single-lane un-reserve; pass an explicit --lane=N');
  }
}

// #2667 — cross-pool release-by-session. `release --all-pools --session=<slug>` sweeps EVERY pool under
// POOL_ROOT and hands back every lane that `<slug>` leases — clearing a cross-locus couple's lease in the WE
// pool AND the plateau-app pool in ONE call (the exact toil the auto-release + this selector remove). It is BY
// SESSION on purpose: the lease markers themselves record the owning session at acquire (dispatch) time, so a
// by-session sweep needs no separate `(pool, lane)` ledger — the markers ARE that record. A blanket cross-pool
// `--all` would nuke every session's leases everywhere, so `--all-pools` REQUIRES `--session` and refuses
// `--all`. Reserved (permanent memory) leases are always skipped — a sweep never un-reserves.
function cmdReleaseAllPools() {
  const session = flags.session || process.env.LANE_SESSION || null;
  // #2748 — a by-ITEM selector generalizes the #2667 by-session sweep so the DRAIN can release an item's lease
  // across every pool at LAND WITHOUT knowing the exact session slug: it matches every lease whose session
  // ENCODES this item number (`conveyor-<num>` / `fix-<num>` / `prepare-<num>` — the same trailing-number rule
  // the reaper's `itemNumFromSession` uses), compared NUMERICALLY so `--item=99` matches `conveyor-99`. This is
  // the universal cleanup key the drain owns: it already has the item number at land (from the queued manifest),
  // for every land path (conveyor / solo /pr / /finish), whereas the exact session slug it does not.
  const itemFlag = flags.item !== undefined ? String(flags.item).trim() : null;
  const wantItem = itemFlag != null && itemFlag !== '' ? Number(itemFlag) : null;
  if (!session && wantItem == null) {
    fail('release --all-pools requires --session=<slug> or --item=<num> — it releases THAT session\'s (or item\'s) leases in every pool; a blanket cross-pool release is deliberately not offered');
  }
  if (session && wantItem != null) {
    fail('release --all-pools takes --session OR --item, not both — pick the one selector for the targeted cross-pool release');
  }
  if (flags.all) {
    fail('release --all-pools --all is not allowed — cross-pool release is BY SESSION / BY ITEM (targeted); pass --session=<slug> or --item=<num> alone');
  }
  // The selector predicate: by exact session (#2667) or by encoded item number (#2748).
  const selects = (lease) => {
    if (session) return leaseOwnedBy(lease, session); // only THIS session's leases — never a foreign one
    const n = itemNumFromSession(lease.session);       // by-item: the lease's session encodes this item number
    return n != null && Number(n) === wantItem;
  };
  const selectorLabel = session ? `session "${session}"` : `item #${wantItem}`;
  const pools = existingPools();
  const perPool = [];
  let released = 0;
  for (const name of pools) {
    const poolDir = join(POOL_ROOT, name);
    const lanes = [];
    for (const n of laneIndicesIn(poolDir)) {
      const dir = join(poolDir, `lane-${n}`);
      const lease = readLease(dir);
      if (!lease) continue;
      if (!selects(lease)) continue; // only the selected session's / item's leases — never a foreign one
      if (isReservedLease(lease)) {
        // A reserved lane owned by this session is still off-limits to a bulk sweep (its whole point is to
        // survive routine release); un-reserving stays the deliberate single-lane `--release-reserved` act.
        log(`  ${name}/lane-${n}: ${describeLease(lease)} — reserved; skipped (un-reserve is single-lane --release-reserved)`);
        continue;
      }
      rmSync(LEASE_MARKER(dir), { force: true });
      log(`  released ${name}/lane-${n} (was ${describeLease(lease)})`);
      lanes.push(n);
      released++;
    }
    if (lanes.length) perPool.push({ pool: name, lanes });
  }
  if (released === 0) log(`  no leases held by ${selectorLabel} in any pool (${pools.length} pool(s) scanned)`);
  if (flags.json) process.stdout.write(JSON.stringify({ session: session || null, item: wantItem, released, pools: perPool }, null, 2) + '\n');
}

function cmdRelease(repo) {
  assertReleaseReservedScoped();
  if (flags['all-pools']) return cmdReleaseAllPools(); // #2667 — cross-pool release-by-session
  const session = defaultSession();
  const force = !!flags.force;
  const nowMs = Date.now();
  const ttlMs = ttlMsFromFlags();
  let targets;
  // #2452 review — `targeted` is load-bearing for ownership, not cosmetic: only a release that NAMES one lane
  // may use the durable-`ownerSession` fallback below. A `--all` sweep keeps the exact-`session` rule.
  let targeted;
  if (flags.all) { targets = existingLanes(repo).filter((n) => readLease(laneDir(repo, n))); targeted = false; } // every held lane
  else if (flags.lane !== undefined) { targets = [Number(flags.lane)]; targeted = true; }
  else return fail('release needs --lane=N or --all');
  let released = 0;
  for (const n of targets) {
    const dir = laneDir(repo, n);
    const lease = readLease(dir);
    if (!lease) { log(`  lane-${n}: no lease to release`); continue; }
    // #2350 — a RESERVED (permanent) lane is NEVER handed back by an ordinary `release` (not even `--force`):
    // its whole point is to be a durable, off-limits slot. Only the deliberate `--release-reserved` un-reserve
    // drops it. This keeps a stray `release --all` / `--force` from silently un-reserving the memory-lane.
    if (isReservedLease(lease) && !flags['release-reserved']) {
      log(`  lane-${n}: ${describeLease(lease)} — a PERMANENT reserved lane; --force does not release it. Pass --release-reserved to deliberately un-reserve.`);
      continue;
    }
    // #2350 — `--release-reserved` bypasses the ownership check ONLY for a RESERVED lease (its reserving owner
    // is a fixed slug, so the human un-reserving is typically a different session). It must NOT double as a
    // `--force` for an ordinary FOREIGN lease — that still requires the explicit `--force`.
    const bypassOwnership = force || (flags['release-reserved'] && isReservedLease(lease));
    // #2452 (Gap 2) — ownership is decided by `leaseOwnedByCaller`, NOT the bare `leaseOwnedBy(lease, session)`
    // exact-string match: `session` here is `defaultSession()`, which falls back to `${hostname()}:${process.ppid}`
    // when no `--session`/`LANE_SESSION` is given, and a shell's ppid differs across separate invocations — so
    // the very session that ACQUIRED a lease read as foreign on a later `release` call and had to `--force`.
    // `leaseOwnedByCaller` still honors an exact `session` match FIRST (the minted slug a MARKED workflow-lane
    // lease requires), then — ONLY for a `--lane=N`-targeted release — falls back to the durable `ownerSession`
    // (`CLAUDE_CODE_SESSION_ID`) signal #2367 already uses for foreign-lease detection, stable across a
    // session's separate Bash-tool calls. #2452 review — the `--all` SWEEP is deliberately excluded: sibling
    // conveyor lanes are UNMARKED yet share one `ownerSession`, so a bare `release --all` would otherwise drop
    // a sibling's live hold with no `--force`. Naming the lane is what makes the intent unambiguous.
    // #2997 — …and `targeted` alone was NOT enough. On 2026-08-14 a subagent ran `release --lane=5` meaning
    // its OWN lease and released a DIFFERENT concurrent holder's: both leases carried the same parent
    // `CLAUDE_CODE_SESSION_ID`, so the step-2 fallback resolved to "same session, therefore mine". Naming a
    // lane proves the caller MEANT that lane, never that it HOLDS it. So when the lease is CONTESTED — another
    // LIVE lease in this pool shares its `ownerSession`, i.e. a sibling agent of mine is holding a lane right
    // now — the ambient id is provably ambiguous and the fallback is refused; ownership must come from the
    // minted `holder` slug (passed as `--session=`/`LANE_SESSION=`) or the explicit `--force`. Nothing was lost
    // in that incident only because the other holder had already finished; a released lane is immediately
    // re-issuable and the next `acquire` resets it, so `release` alone is a data-loss path, not a bookkeeping one.
    const mySessionId = process.env.CLAUDE_CODE_SESSION_ID || null;
    // #2997 r2 (review F2) — staleness-check the SUBJECT lease too, not only the siblings. Without this an
    // EXPIRED lease sharing its `ownerSession` with a live sibling read as CONTESTED and became unreleasable
    // without `--force` — a regression against main, and a direct contradiction of this item's own ruling that
    // "a stale lease reads as no lease, EVERYWHERE" (true in guard-bash.mjs and guard-lane.mjs, false here).
    // A dead holder has nothing to protect: there is no one to be confused with, so nothing to prove.
    const contested = !isLeaseStale(lease, nowMs, ttlMs)
      && isContestedLease({ lease, siblingLeases: liveLeasesInPoolExcept(repo, n, nowMs, ttlMs) });
    if (!bypassOwnership && !leaseOwnedByCaller({ lease, session, mySessionId, targeted, contested })) {
      const holder = laneHolderSlug(lease);
      log(
        `  lane-${n}: ${describeLease(lease)} — not yours; pass --force to break` +
        (!targeted && leaseOwnedByCaller({ lease, session, mySessionId, targeted: true, contested })
          ? ` (a --all sweep never releases on the ownerSession match alone — re-run as \`release --lane=${n}\` to release just this one)`
          : '') +
        (contested && holder
          ? `\n    This lease is CONTESTED (#2997): a SIBLING agent of your own session holds another lane right now,` +
            ` so the session id reads "mine" for BOTH of you and cannot tell your lane from theirs — which is how a` +
            ` release meant for one lane dropped another holder's lease on 2026-08-14.` +
            `\n    If lane-${n} really is yours, prove it with the holder slug \`acquire\` printed for it:` +
            `\n      node scripts/lane-pool.mjs release --lane=${n} --session=${holder}` +
            `\n    If it is not, you probably meant the lane YOU acquired — check \`lane-pool.mjs status\` first.`
          : ''),
      );
      continue;
    }
    rmSync(LEASE_MARKER(dir), { force: true });
    log(`  released lane-${n} (was ${describeLease(lease)})`);
    released++;
  }
  if (flags.json) process.stdout.write(JSON.stringify({ released, targets }, null, 2) + '\n');
}

function printStatus(repo) {
  const rows = existingLanes(repo).map((n) => laneStatus(repo, n));
  if (flags.json) {
    process.stdout.write(JSON.stringify({ repo: repo.name, root: repo.poolDir, lanes: rows }, null, 2) + '\n');
    return;
  }
  if (rows.length === 0) {
    log(`(no lanes provisioned for "${repo.name}" under ${repo.poolDir})`);
    return;
  }
  log(`pool "${repo.name}" @ ${repo.poolDir} (integration branch: origin/${repo.branch})`);
  for (const r of rows) {
    log(
      `  lane-${r.lane}: ${r.head} [${r.branch}] ${r.clean ? 'clean' : 'DIRTY'}` +
        ` · ${r.behind === 0 ? 'up-to-date' : `${r.behind} behind`} · deps ${r.deps}` +
        (r.leased ? ` · ${describeLease(r.lease)}` : ''),
    );
  }
}

function cmdList(repo) {
  let lanes = existingLanes(repo);
  // #2426 — `--acquirable` drops any lane a picker must not couple an item onto: one holding a LIVE (foreign)
  // lease or someone's un-pushed work. The parallel /workflow dispatch used the bare list and assigned items to
  // held lanes by position, so a foreign-leased lane's item was carried with zero work. Filtering here (same
  // decision core `acquire` uses) is the throughput fix — the batch holds no leases, so every live lease it sees
  // is foreign; `isLaneAcquirable` excludes all live leases, which is exactly the set to skip.
  if (flags.acquirable) {
    const nowMs = Date.now();
    const ttlMs = ttlMsFromFlags();
    lanes = lanes.filter((n) => isLaneAcquirable(laneAcquirableInfo(repo, n), nowMs, ttlMs));
  }
  const paths = lanes.map((n) => laneDir(repo, n));
  if (flags.json) process.stdout.write(JSON.stringify(paths, null, 2) + '\n');
  else paths.forEach((p) => process.stdout.write(p + '\n'));
}

function cmdPath(repo) {
  const n = Number(flags.lane);
  if (!Number.isInteger(n) || n < 1) fail('path needs --lane=<positive integer>');
  const dir = laneDir(repo, n);
  if (!existsSync(dir)) fail(`lane-${n} does not exist (${dir})`);
  process.stdout.write(dir + '\n');
}

function cmdRemove(repo) {
  assertReleaseReservedScoped();
  let targets;
  if (flags.all) targets = existingLanes(repo);
  else if (flags.lane !== undefined) targets = [Number(flags.lane)];
  else return fail('remove needs --lane=N or --all');
  // #2350 (review:changes on #745) — `remove` does an unconditional `rmSync(dir, {recursive,force})`, which
  // would destroy a RESERVED memory lane, its `agent-memory-src`, and all accrued memory — the exact wipe
  // #2350 exists to prevent. So a reserved lane is off-limits to `remove` the same way it is to
  // `refresh`/`release`: skipped (loud), never torn down. The ONE escape hatch is the deliberate
  // `--release-reserved` (single-lane; see assertReleaseReservedScoped). This runs REGARDLESS of any --force:
  // a reserved lane's whole point is to survive routine `remove --all` pool teardown.
  const removable = targets.filter((n) => {
    const lease = readLease(laneDir(repo, n));
    if (isReservedLease(lease) && !flags['release-reserved']) {
      log(`  lane-${n}: ${describeLease(lease)} — a PERMANENT reserved lane; remove refuses it. Pass --release-reserved --lane=${n} to deliberately tear it down.`);
      return false;
    }
    return true;
  });
  unmapLanes(repo, removable); // a torn-down lane must stop receiving proxied page requests (#2139); a skipped reserved lane still serves
  for (const n of removable) {
    const dir = laneDir(repo, n);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      log(`removed lane-${n} (${dir})`);
    }
  }
}

// ── adopt (#2997 r2) — the dispatcher → worker OCCUPANCY hand-off ──────────────────────────────────
//
// WHY THIS EXISTS. `acquire` stamps `ownerSession` from the env of the process that RUNS it. When an operator
// (or any dispatcher) leases a lane on an agent's behalf, that field records the DISPATCHER — the agent then
// sent to work in the lane runs under a session id of its own. So `ownerSession` answers "who leased it",
// never "who is working in it", and the Edit/Write guard cannot safely deny on it (it would refuse the lane's
// own occupant — the F1 finding on PR #1234). `adopt` is the missing half: the WORKER declares itself, the
// marker records it in the dedicated `workerSession` field, and from that moment `guard-lane.mjs` refuses
// Edit/Write from any OTHER session. Idempotent; a lane already occupied by a different LIVE session needs
// `--force` (deliberate takeover), which prints who is being displaced.
function cmdAdopt(repo) {
  const n = Number(flags.lane);
  if (!Number.isInteger(n) || n < 1) fail('adopt needs --lane=<positive integer> — it declares YOU the occupant of that lane');
  const me = process.env.CLAUDE_CODE_SESSION_ID || null;
  if (!me) fail('adopt needs a durable session id (CLAUDE_CODE_SESSION_ID) to stamp — without one there is nothing to declare, and the Edit/Write guard stays fail-open for this lane');
  const dir = laneDir(repo, n);
  const lease = readLease(dir);
  if (!lease) fail(`lane-${n} holds no lease to adopt — acquire it first (\`acquire --lane=${n} --purpose=<why> --adopt\`)`);
  if (isLeaseStale(lease, Date.now(), ttlMsFromFlags())) {
    fail(`lane-${n}'s lease is STALE (${describeLease(lease)}) — a stale lease reads as no lease; re-acquire the lane rather than adopting a dead hold`);
  }
  const current = laneWorkerSession(lease);
  if (current && current !== me && !flags.force) {
    fail(
      `lane-${n} is already declared as occupied by session ${current} (${describeLease(lease)}) — adopting it would take it out from under a working agent.\n` +
      `    If that agent is gone, pass --force to take it over deliberately; otherwise acquire your own lane (\`acquire --purpose=<why> --adopt\`).`,
    );
  }
  writeFileSync(LEASE_MARKER(dir), JSON.stringify({ ...lease, workerSession: me }, null, 2) + '\n');
  log(`  adopted lane-${n} — occupant session is now ${me}${current && current !== me ? ` (took over from ${current})` : ''}`);
  log('    Edit/Write into this lane from ANY other session is now refused by guard-lane.mjs (#2997).');
  if (flags.json) process.stdout.write(JSON.stringify({ lane: n, path: dir, workerSession: me, previousWorkerSession: current }, null, 2) + '\n');
}

// ── map / unmap (#2139) — maintain the item → lane page-port registry ───────────────────────────────
function cmdMap(repo) {
  const n = Number(flags.lane);
  if (!Number.isInteger(n) || n < 1) fail('map needs --lane=<positive integer>');
  const items = String(flags.item ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s));
  if (items.length === 0) fail('map needs --item=NNN[,NNN…]');
  const port = lanePagePort(repo, n);
  if (port === null) fail(`pool "${repo.name}" has no PORT_BANDS entry — no page port to map`);
  registerItemsToLane(repo, n, items);
  log(`mapped ${items.join(', ')} → lane-${n} (port ${port}) in ${registryPath(repo)}`);
}

function cmdUnmap(repo) {
  if (flags.all) {
    writePortRegistry(repo, {});
    log(`cleared ${registryPath(repo)}`);
    return;
  }
  if (flags.lane !== undefined) return unmapLanes(repo, [Number(flags.lane)]);
  const items = String(flags.item ?? '')
    .split(',')
    .map((s) => String(Number(s.trim())))
    .filter((s) => s !== 'NaN');
  if (items.length === 0) fail('unmap needs --item=NNN[,NNN…], --lane=N, or --all');
  const entries = readPortRegistry(repo);
  const dropped = items.filter((num) => num in entries);
  for (const num of dropped) delete entries[num];
  writePortRegistry(repo, entries);
  log(dropped.length ? `unmapped ${dropped.join(', ')}` : '(nothing to unmap)');
}

// ── dispatch ──────────────────────────────────────────────────────────────────────────────────────
const COMMANDS = {
  provision: cmdProvision,
  refresh: cmdRefresh,
  status: printStatus,
  list: cmdList,
  path: cmdPath,
  acquire: cmdAcquire,
  adopt: cmdAdopt,
  release: cmdRelease,
  remove: cmdRemove,
  map: cmdMap,
  unmap: cmdUnmap,
};

if (!cmd || cmd === 'help' || cmd === '--help' || !COMMANDS[cmd]) {
  if (cmd && cmd !== 'help' && cmd !== '--help') process.stderr.write(`unknown command: ${cmd}\n`);
  process.stderr.write(
    'usage: lane-pool.mjs <provision|refresh|status|list|path|acquire|adopt|release|remove|map|unmap> [--count=N] [--lane=N] [--all] [--all-pools] ' +
      '[--item=NNN[,NNN…]] [--purpose=<slug>] [--session=<slug>] [--adopt] [--scope=<repo:path,...>] [--reserve] [--release-reserved] [--ttl-minutes=N] [--no-reset] [--repo=<path>] [--pool=<name>] [--origin=<url>] ' +
      '[--reference=<path>] [--name=<slug>] [--branch=<ref>] [--no-install] [--force] [--json]\n',
  );
  process.exit(cmd && COMMANDS[cmd] === undefined && cmd !== 'help' ? 1 : 0);
}

COMMANDS[cmd](resolveRepo());
