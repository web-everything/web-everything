/**
 * @file world.mjs — epic #3383 part 1 (World). One `mkdtemp` root per scenario holding everything the daemon
 * scenario simulator needs to run the REAL daemon code against a fake outside world — see
 * `reports/2026-09-24-daemon-scenario-simulator.md` for the full design and `AGENTS.md`/this task's own brief
 * for the exact layout this file is required to build.
 *
 * TEMPLATE ORIGIN (cached per process). `templates()` below builds, ONCE per node process (module-level
 * memoized), a bare git repo per constellation repo: `we`'s carries a real commit of the CURRENT working
 * tree's `scripts/`, `skills-src/`, `package.json` and `package-lock.json` — via `git ls-files -co
 * --exclude-standard` (so UNCOMMITTED edits in this lane are included; that is how reverting a fix makes the
 * simulator's RED run genuinely red). `frontierui`/`plateau-app` get a tiny fixture repo instead — the daemon
 * iterates all three constellation slugs every tick (`REVIEW_DAEMON_REPOS`), so `gh pr list --repo <slug>`
 * against them must resolve to a REGISTERED, empty repo rather than an unknown-repo throw. Every `createWorld()`
 * call then does a shared bare-to-bare `git clone` of these cached templates into its own scenario root — the
 * expensive tree-assembly work happens once, the per-scenario clone is cheap.
 *
 * Every constellation repo, not just the ones a scenario's own `repos:` option names, gets a bare origin +
 * fake-gh registration — `repos` only marks which repo(s) a scenario is actually exercising/asserting against;
 * the OTHER constellation repos still need to exist as empty, well-formed repos so the review/fix daemons'
 * per-repo loop (`forEachRepo`) sees a clean "nothing owed" rather than an unknown-repo error for them.
 */

import { execFileSync } from 'node:child_process';
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFakeGithub } from '../helpers/fake-gh.mjs';
import { createFakeClaude } from '../../../operations/__tests__/helpers/fake-claude.mjs';
import { createSimClock } from './clock.mjs';
import { nodeRuntimeEnv } from './node-runtime-env.mjs';
import { seedLaneDependencies } from './dependencies.mjs';
import { writeFixtureNpm } from './npm-shim.mjs';
import { isolatedProcessEnv, toolPathDirs } from './environment.mjs';
import * as act from './agent-actions.mjs';
import { CONSTELLATION_REPOS } from '../../../lib/constellation-repos.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** This lane's own working tree root — NEVER the sim clone. Resolved by script location, mirroring every
 *  `REPO_ROOT` convention in this repo, so this file works regardless of the caller's own cwd. */
const INVOKING_ROOT = resolve(HERE, '..', '..', '..', '..');

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// small git helpers
// ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function git(cwd, args, opts = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

function configureRepo(dir) {
  git(dir, ['config', 'user.email', 'sim@example.com']);
  git(dir, ['config', 'user.name', 'Sim World']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  // No background auto-gc: the template holds thousands of loose objects (scripts/ is large), so the first
  // `git commit` spawned a DETACHED `gc --auto` that packed and deleted loose objects while the next step was
  // `git clone` of that very repo — "failed to copy file ... No such file" / "unable to read tree", a crash in
  // EVERY soak scenario (PR #3794 red-green run). Deterministic scenario repos never need gc.
  noAutoGc(dir);
}

/** Also applied to every BARE origin: a `git push` into a bare repo runs `receive-pack`'s own `gc --auto`
 *  (`receive.autogc`, default on), the detached gc that pruned objects under the next scratch clone. */
function noAutoGc(dir) {
  git(dir, ['config', 'gc.auto', '0']);
  git(dir, ['config', 'maintenance.auto', 'false']);
  git(dir, ['config', 'receive.autogc', 'false']);
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// template origins — built once per process, cached here
// ──────────────────────────────────────────────────────────────────────────────────────────────────────────

let templateCache = null;

/** The `we` template: a real commit of this working tree's tracked+uncommitted `scripts/`, `skills-src/`,
 *  `package.json`, `package-lock.json` — the daemon import graph's own dependency set (found by running the
 *  daemons against progressively wider copies; nothing outside these needed adding). `git ls-files -co
 *  --exclude-standard` (not a blind full-tree copy) so gitignored junk (`node_modules`, `_site/`, …) never
 *  rides along and so an uncommitted fix in THIS lane is what the simulator actually runs.
 *  Tests, fixtures and corpora are excluded: per-scenario checkout/clone/teardown cost scales with this
 *  tree, and that cost under CI load caused A3 to time out. Fake gh/claude helpers and their shims resolve
 *  from INVOKING_ROOT, not the sim clone, so they do not need to ride along. */
function buildWeTemplate() {
  const listed = execFileSync(
    'git',
    [
      'ls-files', '-co', '--exclude-standard', '--',
      'scripts', 'skills-src', 'package.json', 'package-lock.json',
      // Brief rendering reads this living checklist relative to the cloned build-policy module.
      // Keep the real dependency: a missing checklist must still fail closed in production.
      'docs/agent/reviewer-expectations.md',
      // `.gitignore` itself MUST ride along: `lane-pool.mjs` writes a per-lane `.env.local` expecting it to be
      // gitignored (real repo behaviour, confirmed) — without this file in the template, every provisioned
      // lane reads as permanently dirty (`.env.local` shows up as a genuine untracked file) and
      // `list --acquirable` reports zero lanes no matter how many were provisioned (#3383 gap — see this
      // file's own git-blame/report for the live incident this fixed).
      '.gitignore',
      // #3383 (scenario B, I-07) — the canonical backlog loader `we:scripts/operations/dispatch-lane-io.mjs
      // #defaultLoadItems` requires this file BY PATH (`require(join(root,'src','_data','backlog.js'))`), off
      // the SIM CLONE's own `root` (every daemon that resolves a PR's backlog item — review, fix-dispatch —
      // dynamically imports its own module graph FROM the clone, never from this lane). Without it here, that
      // `require` throws MODULE_NOT_FOUND, `findItem` swallows it (`catch { return null }`), and EVERY PR reads
      // as item-less no matter what backlog card a scenario writes into `WE_BACKLOG_DIR` — a fix dispatch whose
      // scenario needs a real item (a declared `scope:`, not the item-less PR-diff fallback) would silently and
      // confusingly fall back to that population instead. The loader's own requires beyond this are ordinary
      // npm packages (`gray-matter`, `markdown-it`) already resolved via the symlinked `node_modules` below —
      // no other local repo-relative file is needed.
      'src/_data/backlog.js',
      // `we:scripts/operations/worker-result.mjs` reads this schema BY PATH at import time, relative to the
      // clone's own `scripts/operations/` — and `completion-store.mjs` (so `lane-pool.mjs provision`, every
      // daemon) imports it transitively. Without it every sim-world `lane-pool.mjs` call dies on import ENOENT.
      'schemas/worker-result.v1.json',
    ],
    { cwd: INVOKING_ROOT, encoding: 'utf8' },
  ).split('\n').filter(Boolean).filter((path) =>
    !/(^|\/)__tests__\/|\.(?:test|spec)\.[^/]+$/.test(path)
    && !/^scripts\/(?:golden-corpus|review-corpus)\//.test(path)
    && !/^scripts\/(?:.*\/)?fixtures\//.test(path));

  const work = mkdtempSync(join(tmpdir(), 'sim-template-we-'));
  for (const rel of listed) {
    const src = join(INVOKING_ROOT, rel);
    if (!existsSync(src)) continue; // a deleted-but-still-listed path (rare) — nothing to copy
    const dst = join(work, rel);
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, readFileSync(src));
  }
  git(work, ['init', '-q']);
  git(work, ['symbolic-ref', 'HEAD', 'refs/heads/main']); // never trust the ambient init.defaultBranch
  configureRepo(work);
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'sim template: scripts/ + skills-src/ + package.json snapshot']);

  // Every world, lane and main-move scratch clone inherits this object database. Leave it packed rather than
  // copying thousands of loose-object directory entries on every local clone. Repack synchronously BEFORE
  // publishing the template; background auto-gc stays disabled so it cannot race a scenario's next clone.
  git(work, ['repack', '-ad']);

  const bare = mkdtempSync(join(tmpdir(), 'sim-template-we-bare-'));
  rmSync(bare, { recursive: true, force: true }); // git clone --bare refuses an existing target dir
  git(work, ['clone', '--quiet', '--bare', work, bare]);
  rmSync(work, { recursive: true, force: true });
  return bare;
}

/** A tiny fixture repo for a sibling constellation repo — just enough for `gh pr list --repo <slug>` to see a
 *  real, empty, well-formed repo. Never the daemon's own import surface (nothing runs FROM these). */
function buildTinyTemplate(key) {
  const work = mkdtempSync(join(tmpdir(), `sim-template-${key}-`));
  writeFileSync(join(work, 'package.json'), `${JSON.stringify({ name: key, version: '0.0.0' }, null, 2)}\n`);
  writeFileSync(join(work, 'README.md'), `# ${key} (simulator fixture — not the real repo)\n`);
  git(work, ['init', '-q']);
  git(work, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  configureRepo(work);
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'sim template: tiny fixture']);

  const bare = mkdtempSync(join(tmpdir(), `sim-template-${key}-bare-`));
  rmSync(bare, { recursive: true, force: true });
  git(work, ['clone', '--quiet', '--bare', work, bare]);
  rmSync(work, { recursive: true, force: true });
  return bare;
}

function templates() {
  if (!templateCache) {
    templateCache = {
      we: buildWeTemplate(),
      frontierui: buildTinyTemplate('frontierui'),
      'plateau-app': buildTinyTemplate('plateau-app'),
    };
  }
  return templateCache;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// createWorld
// ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Base environment shared by every host and child in one simulated world.
 * Vitest supplies a per-file throttle root, but each world resets its own clock. Sharing that root carries
 * spent budget windows from an earlier world's future into the next world's baseline, making each call wait
 * out the production admission timeout. Keep sibling hosts sharing one budget, scoped to this world's cleanup.
 */
export function worldEnv(root, ambient = process.env) {
  return { ...ambient, WE_GH_THROTTLE_LOCK_ROOT: join(root, 'gh-throttle') };
}

/**
 * @param {{repos?: string[], lanes?: number, clockStartOffsetMs?: number}} [o]
 */
export function createWorld({ repos = ['we'], lanes = 3, clockStartOffsetMs = 0 } = {}) {
  // realpathSync IMMEDIATELY, not just mkdtempSync — #3383 gap, found live: on macOS `os.tmpdir()` resolves
  // under `/var/...`, a symlink to `/private/var/...`. Every daemon script this world ever hands to a real
  // `node <path>` invocation resolves its OWN `IS_CLI` self-check as `resolve(process.argv[1]) ===
  // resolve(new URL(import.meta.url).pathname)` (`review-set-label.mjs` and others) — and Node's ESM loader
  // canonicalizes `import.meta.url` via realpath while leaving `process.argv[1]` as the literal argv string.
  // Left unresolved, EVERY path this world ever computes (`simCloneRoot`, lane dirs, …) carries the
  // un-canonicalized `/var/...` prefix, the two sides of that comparison permanently disagree, `IS_CLI` reads
  // false, and the CLI silently no-ops (exit 0, empty stdout, nothing written) — no error, no hint. Resolving
  // ONCE, here, on the root, means every path derived from it below (`join(root, …)`) is already canonical.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sim-world-')));
  const tpl = templates();

  // (a) a bare origin per constellation repo — ALWAYS all three, see file header.
  const repoEntries = {};
  for (const key of Object.keys(CONSTELLATION_REPOS)) {
    const slug = CONSTELLATION_REPOS[key].slug;
    const originPath = join(root, 'github', `${slug}.git`);
    mkdirSync(dirname(originPath), { recursive: true });
    // Templates are immutable and outlive every world in this process. Borrow their objects instead of
    // copying thousands of loose-object directory entries into every origin, daemon and lane clone.
    // Each world's refs and newly pushed objects remain private; auto-gc stays disabled below.
    git(root, ['clone', '--quiet', '--bare', '--shared', tpl[key], originPath]);
    noAutoGc(originPath);
    repoEntries[key] = { key, slug, originPath, defaultBranch: 'main' };
  }

  // (b) the daemon's own dedicated clone — always of `we` (every resident daemon this epic builds runs from
  // its own WE checkout, whichever repo's PR it happens to be working on that tick).
  const simClone = join(root, 'wev-daemon'); // NEVER named `lane-\d+` — review-dispatch.mjs#assertNotALaneCheckout
  git(root, ['clone', '--quiet', repoEntries.we.originPath, simClone]);
  configureRepo(simClone);
  const nodeModulesSrc = join(INVOKING_ROOT, 'node_modules');
  if (existsSync(nodeModulesSrc)) {
    try { symlinkSync(nodeModulesSrc, join(simClone, 'node_modules'), 'dir'); } catch { /* best effort */ }
  }
  // The symlink itself is an untracked path `git status --porcelain` would otherwise report — exclude it so
  // self-sync's/main-staleness's dirty-tree checks see a clean clone (design brief's own instruction).
  appendFileSync(join(simClone, '.git', 'info', 'exclude'), '\nnode_modules\n');
  const dirtyAfterClone = git(simClone, ['status', '--porcelain']).trim();
  if (dirtyAfterClone) {
    throw new Error(`world: the sim clone is dirty right after cloning — self-sync/main-staleness would refuse it:\n${dirtyAfterClone}`);
  }

  // (c) fake HOME
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });

  // (d) lane pool root (provisioned below, once the merged env exists)
  const lanePoolRoot = join(root, 'lanes');
  mkdirSync(lanePoolRoot, { recursive: true });

  // (e) misc dirs
  const completionsDir = join(root, 'completions');
  mkdirSync(completionsDir, { recursive: true });
  const backlogDir = join(root, 'backlog');
  mkdirSync(backlogDir, { recursive: true });
  const smokeStateDir = join(root, 'smoke-state');
  mkdirSync(smokeStateDir, { recursive: true });

  // (f) fake GitHub over every constellation repo
  const rawGh = createFakeGithub({
    root: join(root, 'fake-gh'),
    repos: Object.values(repoEntries).map((r) => ({ slug: r.slug, originPath: r.originPath, defaultBranch: r.defaultBranch })),
    actor: 'we-daemon-bot',
  });

  // (g) fake claude, home = the SAME fake HOME (so `~/.claude/projects/...` transcripts land under it)
  const rawClaude = createFakeClaude({ root: join(root, 'fake-claude'), home });

  // (h) sim clock
  const clock = createSimClock({ file: join(root, 'clock.json'), startOffsetMs: clockStartOffsetMs });

  // (i) one merged env
  const ghBinDir = rawGh.env.PATH.split(':')[0];
  const claudeBinDir = rawClaude.env.PATH.split(':')[0];
  // These scenarios script Claude sessions (including Claude-specific auth failures). Keep the
  // production policy and exercise its declared fallback, with only our fake provider installed.
  // Never let a developer's real Codex/agy binary turn a soak into a paid, unscripted launch.
  const toolsDir = join(root, 'tools');
  mkdirSync(toolsDir);
  // Initial lanes are seeded below, but a smoke can grow the pool or install into a fresh snapshot.
  // Cover those paths too: npm may reuse the matching local fixture, never download dependencies.
  writeFixtureNpm(toolsDir);
  const linked = new Set(['claude', 'codex', 'agy', 'npm']);
  for (const dir of toolPathDirs()) {
    // The operator's GitHub App shim is live credential state, not a tool directory to enumerate.
    // The world's own fake gh already wins PATH; none of the shim's siblings belong in this world.
    if (/(^|\/)gh-shim\.d(\/|$)/.test(dir)) continue;
    let names;
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (linked.has(name)) continue;
      symlinkSync(resolve(dir, name), join(toolsDir, name));
      linked.add(name);
    }
  }
  const env = {
    ...isolatedProcessEnv(root),
    // Every tick launches many Node CLIs over the same large daemon module graph. One disposable cache per
    // world reduces repeated compilation within the sibling scenario / 50-tick soak budgets, without
    // sharing module state or skipping any real tick.
    ...nodeRuntimeEnv(root),
    PATH: [ghBinDir, claudeBinDir, toolsDir].join(':'),
    NODE_OPTIONS: clock.env.NODE_OPTIONS,
    HOME: home,
    SIM_CLOCK_FILE: clock.env.SIM_CLOCK_FILE,
    FAKE_GH_STORE: rawGh.env.FAKE_GH_STORE,
    FAKE_GH_LOG: rawGh.env.FAKE_GH_LOG,
    FAKE_GH_ACTOR: rawGh.env.FAKE_GH_ACTOR,
    FAKE_CLAUDE_STORE: rawClaude.env.FAKE_CLAUDE_STORE,
    FAKE_CLAUDE_CALLS: rawClaude.env.FAKE_CLAUDE_CALLS,
    FAKE_CLAUDE_HOME: rawClaude.env.FAKE_CLAUDE_HOME,
    SIM_NPM_MODULES: nodeModulesSrc,
    SIM_NPM_LOCKFILE: join(INVOKING_ROOT, 'package-lock.json'),
    LANE_POOL_ROOT: lanePoolRoot,
    // vitest.setup.ts supplies a per-file throttle root, which takes precedence over LANE_POOL_ROOT.
    // Worlds have independent clocks: an earlier world's +11m budget window must never make a fresh
    // world wait out the 2m admission timeout on every gh call. Keep admission enabled, scoped per world.
    // All children of one world still share its gate. Cleanup owns this root.
    WE_GH_THROTTLE_LOCK_ROOT: join(root, 'gh-throttle'),
    OPERATION_COMPLETIONS_DIR: completionsDir,
    WE_BACKLOG_DIR: backlogDir,
    WE_DAEMON_SMOKE_STATE_DIR: smokeStateDir,
    // #4075 soak harness gap: on lane/4044 EVERY daemon tick's `withSelfSync` unconditionally drives the real
    // rebuild (`daemon-rebuild.mjs#rebuildClone`/`doRebuild`), which persists its own per-clone state
    // (`isDaemonManagedClone`'s own marker, `state.rejected`/`retryAt`, …) under
    // `<WE_DAEMON_STATE_DIR || ~/.claude/daemon-self-sync-state>/<cloneKey>.rebuild.json` — the SAME real
    // directory the operator's actual resident daemon uses for its OWN state. Left unset, every soak run on
    // lane/4044 leaves a permanent `<hash>.rebuild.json`/`.alerts.jsonl` pair there (found live: confirmed empty
    // collision risk only because the sim clone's realpath happens to hash differently from the real daemon's,
    // but the accumulation itself is real and never cleaned up by `w.cleanup()`, which only removes `root`).
    // Scoped here exactly like `WE_DAEMON_SMOKE_STATE_DIR` just above, which already isolates the smoke
    // reject-cache the same way.
    WE_DAEMON_STATE_DIR: join(root, 'daemon-self-sync-state'),
    GH_TOKEN: 'sim-token-1',
    // tuning knobs, pinned short so a real failure surfaces fast instead of the suite waiting out production
    // defaults (bounded-child.mjs#CHILD_TIMEOUT_ENV, lane-pool.mjs's own list-cache/scan-timeout env vars).
    WE_CHILD_TIMEOUT_MS: '20000',
    LANE_POOL_LIST_CACHE_TTL_MS: '0',
    LANE_POOL_LIST_SCAN_TIMEOUT_MS: '20000',
    // x26lw6u — production reviews now run as a node JOB (`review-job.mjs`), but every scenario here scripts a
    // review as a fake `claude --bg` session's actions. Pin the opt-in session path until the simulator models
    // the job (filed as its own follow-up) — this keeps the fix/lane/label scenarios exercising what they did.
    WE_REVIEW_DISPATCH_MODE: 'session',
    // Scenario and soak fixtures model the full required-check set, not the production fast-check jobs.
    // Keep both planner and dispatch-time gates on that contract; review-timing-dispatch.test.mjs and
    // review-ci-gate-io.test.mjs cover fast-check eligibility without changing these scenarios' assertions.
    WE_REVIEW_START_AFTER: 'ci-green',
    // Same contract for the fix side: these scenarios script CI repair serially, not joined with a pending review.
    WE_FIX_JOIN_CI_AND_REVIEW: 'false',
    // #4126 — the opted-in daemons' ticks now start/adopt a detached rebuild JOB (`rebuild-job.mjs`) instead of
    // smoking inline, but every scenario here scripts the inline rebuild moving the clone within the tick. Pin the
    // inline path; rebuild-job tests own the job mode.
    WE_DAEMON_REBUILD_AS_JOB: '0',
    // PR #4686 — a build adopted within the last `WE_STALE_GUARD_REBUILD_GRACE_MS` (default 60 min) is no longer
    // refused as stale. Every sim tick adopts a build moments (sim-time) before the scenario moves origin/main, so
    // the default would silently turn the I-18 mid-tick stale-main refusal (self-sync-sibling A2) into no refusal.
    // Pin the grace off (the pre-fix rule); daemon-last-good.test.mjs owns the grace itself.
    WE_STALE_GUARD_REBUILD_GRACE_MS: '0',
    // dispatch-throttle.mjs: the fix/ci-heal live-session cap and the host-load gate defer launches off the REAL
    // host's loadavg and live claims — a soak must be hermetic, or a busy CI runner (4 shards in parallel) reads as
    // an owed PR "never dispatched". Pinned wide open; dispatch-throttle.test.mjs owns the throttle itself.
    WE_FIX_DISPATCH_MAX_CONCURRENT: '1000',
    WE_MAX_LOAD_PER_CORE: '1000',
    // x6nuodj: the launch gates now DECIDE through admit() (cutover=enforce), which holds every heavy kind
    // (ci-heal, fix, review) when no fresh sampler snapshot exists — always the case on a CI runner — so owed PRs
    // read as "never dispatched". Keep the legacy (pinned-open) verdict deciding and skip the shadow log row, which
    // would otherwise land in the operator's real ~/.claude; resource-gate.test.mjs owns the cut-over itself.
    WE_RESOURCE_CUTOVER: 'shadow',
    WE_RESOURCE_SHADOW: 'off',
    // fix.executor defaults to codex-first, which launches ordinary fix / ci-heal rounds through the detached fix-run
    // wrapper — a launch the fake `claude --bg` session store cannot see, so every scenario's "dispatches one fixer /
    // ci-heal session" invariant reads as never dispatched. Pin the Claude path; fix-executor-routing.test.mjs owns
    // the routing itself.
    WE_FIX_EXECUTOR: 'claude',
    // x09e2bn — the drain's red-main freeze reader defaults to the shared ops branch and fails CLOSED when it is
    // unreadable. The sim world has no ops branch, so every drain pass would hold all PRs and nothing would land
    // ("never landed", "never observed an overlap-yield line"). Pin the local reader; red-main-freeze-drain.test.mjs
    // owns the shared reader itself.
    WE_DRAIN_RED_MAIN_FREEZE_READER: 'local-only',
  };
  // This world runs the checkout's policy, not the launching daemon's possibly newer last-good snapshot.
  // Keep an explicit undefined so agent actions spreading process.env before this env cannot restore it;
  // Node omits undefined env entries when spawning the child.
  env.WE_DISPATCH_ROUTING_SNAPSHOT = undefined;

  // Refuse to run unless the fakes actually win PATH — the same `assertWins` discipline `fake-claude.mjs`
  // itself uses, extended to `gh` too, and run BEFORE anything else touches this env.
  const resolveBin = (bin) => {
    try { return execFileSync('sh', ['-c', `command -v ${bin}`], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { return ''; }
  };
  const ghResolved = resolveBin('gh');
  if (ghResolved !== join(ghBinDir, 'gh')) {
    throw new Error(`world: the fake \`gh\` did not win PATH — resolves to ${ghResolved || '(nothing)'}. Refusing to run.`);
  }
  const claudeResolved = resolveBin('claude');
  if (claudeResolved !== join(claudeBinDir, 'claude')) {
    throw new Error(`world: the fake \`claude\` did not win PATH — resolves to ${claudeResolved || '(nothing)'}. Refusing to run.`);
  }
  for (const provider of ['codex', 'agy']) {
    if (resolveBin(provider)) throw new Error(`world: unscripted provider ${provider} is on PATH. Refusing to run.`);
  }

  // (d, continued) provision N lanes via the REAL scripts/lane-pool.mjs, from the sim clone. `--no-install`
  // is the flag that skips `npm ci`/`npm install` entirely (lane-pool.mjs's own `ensureDeps` call sites are
  // ALL gated on `!flags['no-install']`). Later live-smoke acquires do NOT pass that flag, so seed their
  // dependency readiness too: reuse this checkout's installed modules, just like the daemon clone above,
  // and record the lane's lockfile hash in `.git/.lane-pool-deps` (the `depsReady` contract). The npm shim
  // above covers later pool growth and fresh snapshots without downloading dependencies.
  // #4075 soak harness gap — `provision --acquirable` caps NEW clones per call at
  // `ACQUIRABLE_PROVISION_MAX_NEW_DEFAULT` (4, `we:scripts/lane-pool.mjs`), so `createWorld({lanes: N})` for
  // N > 4 silently provisioned only 4 lanes (found building `breaks/lane-acquire-under-load.mjs`, which needs a
  // larger pool to saturate). `--max-new=${lanes}` lifts that cap to exactly what THIS call asked for — never
  // more, and a no-op for every existing scenario (`lanes <= 4`).
  execFileSync(process.execPath, [join(simClone, 'scripts', 'lane-pool.mjs'), 'provision', `--count=${lanes}`, '--acquirable', `--max-new=${lanes}`, '--no-install'], {
    cwd: simClone, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
  });
  if (existsSync(nodeModulesSrc)) {
    for (const pool of readdirSync(lanePoolRoot, { withFileTypes: true })) {
      if (!pool.isDirectory()) continue;
      const poolDir = join(lanePoolRoot, pool.name);
      for (const lane of readdirSync(poolDir, { withFileTypes: true })) {
        if (!lane.isDirectory() || !/^lane-\d+$/.test(lane.name)) continue;
        seedLaneDependencies(join(poolDir, lane.name), nodeModulesSrc);
      }
    }
  }

  // ── git helpers ────────────────────────────────────────────────────────────────────────────────────────
  function commitFiles(repoKey, base, files, msg) {
    const repo = repoEntries[repoKey];
    if (!repo) throw new Error(`world.git: unknown repo "${repoKey}"`);
    const work = mkdtempSync(join(tmpdir(), 'sim-git-index-'));
    const opts = { env: {
      ...process.env,
      GIT_INDEX_FILE: join(work, 'index'),
      GIT_AUTHOR_NAME: 'Sim World', GIT_AUTHOR_EMAIL: 'sim@example.com',
      GIT_COMMITTER_NAME: 'Sim World', GIT_COMMITTER_EMAIL: 'sim@example.com',
    } };
    try {
      git(repo.originPath, ['read-tree', base], opts);
      // Content writes preserve an existing regular file's executable bit, just like writeFileSync.
      // Read the seeded index once; NUL records keep whitespace and quoted filenames literal.
      const executables = new Set(git(repo.originPath, ['ls-files', '--stage', '-z'], opts)
        .split('\0').filter((entry) => entry.startsWith('100755 '))
        .map((entry) => entry.slice(entry.indexOf('\t') + 1)));
      for (const [name, content] of Object.entries(files)) {
        const blob = git(repo.originPath, ['hash-object', '-w', '--stdin'], {
          ...opts, input: content, stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        const mode = executables.has(name) ? '100755' : '100644';
        git(repo.originPath, ['update-index', '--add', '--cacheinfo', `${mode},${blob},${name}`], opts);
      }
      const tree = git(repo.originPath, ['write-tree'], opts).trim();
      // A normal `git commit` rejects both empty files and writes that change nothing.
      if (tree === git(repo.originPath, ['rev-parse', `${base}^{tree}`]).trim()) {
        throw new Error('world.git: nothing to commit (no staged changes)');
      }
      return git(repo.originPath, ['commit-tree', tree, '-p', base, '-m', msg], opts).trim();
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  function headOf(repoKey, ref) {
    const repo = repoEntries[repoKey];
    if (!repo) throw new Error(`world.git: unknown repo "${repoKey}"`);
    return git(repo.originPath, ['rev-parse', ref]).trim();
  }

  const worldGit = {
    /** A human (or another lane) pushing straight to `main` mid-scenario. */
    commitToMain(repoKey, files = {}, msg = 'sim: commit to main') {
      const base = headOf(repoKey, 'main');
      const head = commitFiles(repoKey, base, files, msg);
      git(repoEntries[repoKey].originPath, ['update-ref', 'refs/heads/main', head, base]);
      return headOf(repoKey, 'main');
    },
    /** A real PR-worthy branch on the origin — `from` defaults to `main`; `files`, if given, seed one commit. */
    createBranch(repoKey, name, { from = 'main', files = {} } = {}) {
      const base = headOf(repoKey, from);
      const head = Object.keys(files).length ? commitFiles(repoKey, base, files, `sim: seed ${name}`) : base;
      const origin = repoEntries[repoKey].originPath;
      const ref = `refs/heads/${name}`;
      let current = '0'.repeat(base.length);
      try {
        current = git(origin, ['rev-parse', '--verify', '--quiet', ref]).trim();
      } catch (error) {
        if (error.status !== 1) throw error;
      }
      if (current !== '0'.repeat(base.length)) {
        try {
          git(origin, ['merge-base', '--is-ancestor', current, head]);
        } catch (error) {
          if (error.status !== 1) throw error;
          throw new Error(`world.git: rejected non-fast-forward update to ${ref}`);
        }
      }
      // Match a non-force push, with CAS protecting both creation and advancement.
      git(origin, ['update-ref', ref, head, current]);
      return headOf(repoKey, name);
    },
    headOf,
  };

  // ── fake-gh short-key wrapper (scenario-facing) ───────────────────────────────────────────────────────
  const slugFor = (repoKey) => repoEntries[repoKey]?.slug ?? repoKey;
  const gh = {
    openPr: ({ repo, ...rest }) => rawGh.openPr({ repo: slugFor(repo), ...rest }),
    addLabels: (repo, n, names) => rawGh.addLabels(slugFor(repo), n, names),
    removeLabels: (repo, n, names) => rawGh.removeLabels(slugFor(repo), n, names),
    comment: (repo, n, body, opts) => rawGh.comment(slugFor(repo), n, body, opts),
    setChecks: (repo, n, checks) => rawGh.setChecks(slugFor(repo), n, checks),
    setRequiredChecks: (repo, names) => rawGh.setRequiredChecks(slugFor(repo), names),
    closePr: (repo, n) => rawGh.closePr(slugFor(repo), n),
    reopenPr: (repo, n) => rawGh.reopenPr(slugFor(repo), n),
    mergePr: (repo, n, opts) => rawGh.mergePr(slugFor(repo), n, opts),
    pr: (repo, n) => rawGh.pr(slugFor(repo), n),
    prs: (repo) => rawGh.prs(slugFor(repo)),
    fault: (o) => rawGh.fault(o),
    revokeToken: (t) => rawGh.revokeToken(t),
    calls: () => rawGh.calls(),
    /** The raw `createFakeGithub()` instance, keyed by real gh slug — what `agent-actions.mjs`'s `ctx.gh` and
     *  the scenario snapshot both actually need. */
    raw: rawGh,
  };

  // ── host registry (scenario.mjs registers every forked daemon-host child here) ───────────────────────
  // #3383 harness gap (found building the self-sync-sibling scenarios — a restart-heavy play list is exactly
  // what surfaces this): a daemon host that restarts itself (`process.exit(0)` after sending `{type:'restart'}`
  // — the scenario runner's OWN `tickDaemon` already `hosts.delete(name)`s its LOCAL map on that path) used to
  // stay in THIS registry forever, so `cleanup()` at the end of every scenario still tried to `send()` a
  // shutdown message to an already-exited child's closed IPC channel — an ERR_IPC_CHANNEL_CLOSED that Node
  // raises asynchronously (a plain try/catch around `.send()` does not catch it; it surfaces as an unhandled
  // exception at the vitest-process level, observed on every restart this build exercises). Self-pruning on
  // 'exit' fixes it at the root: a dead child is removed the moment it dies, so `cleanup()` only ever iterates
  // children that were STILL ALIVE when the scenario ended, and the `.connected` guard below is defense in
  // depth for the remaining TOCTOU window between that check and the `send()` call itself.
  const hostRegistry = new Set();
  function registerHost(child) {
    hostRegistry.add(child);
    child.once('exit', () => hostRegistry.delete(child));
  }

  function cleanup() {
    for (const child of hostRegistry) {
      try { if (child.connected) child.send?.({ type: 'shutdown' }, () => {}); } catch { /* best effort */ }
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    hostRegistry.clear();
    try { rawClaude.cleanup(); } catch { /* best effort — also kills every recorded sleeper pid */ }
    try { rawGh.cleanup(); } catch { /* best effort */ }
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  return {
    root,
    simCloneRoot: simClone,
    home,
    lanePoolRoot,
    completionsDir,
    backlogDir,
    smokeStateDir,
    env,
    repos: repoEntries,
    reposRequested: repos,
    gh,
    claude: rawClaude,
    agents: { script: rawClaude.script },
    act,
    clock,
    git: worldGit,
    registerHost,
    cleanup,
  };
}
