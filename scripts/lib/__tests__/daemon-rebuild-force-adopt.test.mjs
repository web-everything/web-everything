/** @file R508 force-adopt wiring through the real rebuildClone: smoke still runs, adopts over a failed smoke only with a
 *  ruling+quote, logs, and the watch reverts to last-good. Fixture helpers are copied from the fallback suite. */
import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync,
} from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  rebuildClone, readRebuildState, candidateSmokeEnv, rebuildStatePath,
  candidateWorktreePath, failsSameChecks, DISPATCH_CWD_ROOT_ENV,
} from '../daemon-rebuild.mjs';
import { addOverlay, readOverlays, removeOverlay } from '../daemon-overlays.mjs';
import { defaultPoolRoot } from '../lane-pool-paths.mjs';
import { DISPATCH_CWD_ENV } from '../../operations/dispatch-lane-io.mjs';
import { requestForceAdopt, readForceWatch, runForceWatchTick, readForceAdopt } from '../daemon-force-adopt.mjs';
// Pre-dates daemonRebuild.skipUnrelated: these tests assert a smoke runs for non-code moves, so pin the knob off.
process.env.WE_DAEMON_REBUILD_SKIP_UNRELATED = '0';

// Same precedent as daemon-rebuild.test.mjs:43. Every case here drives real `git` through rebuildClone (about 40 git
// calls per rebuild: worktree add/remove/prune/list, rev-parse, merge-base), measured at 2-4s per case at load ~30 and
// 7-12s at load ~70, so the 5s default timed out on a loaded CI shard (main red @ 4535653df). Cached fixtures and
// splitting the slowest case did not help (rebuildClone itself is the cost). 60s stays a hang guard.
vi.setConfig({ testTimeout: 60_000 });

// ── fixture helpers — copied from daemon-rebuild.test.mjs (never imported from it) ──────────────────────────

const tempDirs = [];

function mktemp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(cwd, args) {
  return spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd, encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL',
  });
}
function gitOk(cwd, args) {
  const r = git(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function makeAuthorClone(originDir) {
  const parent = mktemp('we-daemon-rebuild-fb-author-');
  const dir = join(parent, 'w');
  const r = spawnSync('git', ['clone', '-q', originDir, dir], {
    encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL',
  });
  if (r.status !== 0) throw new Error(`clone failed: ${r.stderr}`);
  return dir;
}

function pushBranch(originDir, ref, mutate, { base = 'origin/main' } = {}) {
  const dir = makeAuthorClone(originDir);
  gitOk(dir, ['fetch', '-q', 'origin']);
  gitOk(dir, ['checkout', '-q', '-B', ref, base]);
  mutate(dir);
  gitOk(dir, ['add', '-A']);
  gitOk(dir, ['commit', '-q', '-m', `overlay: ${ref}`]);
  gitOk(dir, ['push', '-q', 'origin', `HEAD:refs/heads/${ref}`]);
  return gitOk(dir, ['rev-parse', 'HEAD']).trim();
}

function advanceMain(originDir, mutate) {
  return pushBranch(originDir, 'main', mutate, { base: 'origin/main' });
}

function writeFile(dir, name, content) {
  const full = join(dir, name);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** Fresh {origin (bare), clone (working tree under test), env} fixture — same shape as daemon-rebuild.test.mjs,
 *  but with LANE_POOL_ROOT / WE_DISPATCH_CWD_ROOT explicitly ABSENT so candidateSmokeEnv's own derivation
 *  (never an ambient override from this process's real env) is what a test observes. */
function makeFixture() {
  const base = mktemp('we-daemon-rebuild-fb-fixture-');
  const originDir = join(base, 'origin.git');
  const cloneDir = join(base, 'clone');
  mkdirSync(cloneDir, { recursive: true });
  gitOk(base, ['init', '--bare', '-q', originDir]);
  gitOk(cloneDir, ['init', '-q', '-b', 'main']);
  writeFile(cloneDir, 'README.md', 'init\n');
  gitOk(cloneDir, ['add', '-A']);
  gitOk(cloneDir, ['commit', '-q', '-m', 'init']);
  gitOk(cloneDir, ['remote', 'add', 'origin', originDir]);
  gitOk(cloneDir, ['push', '-q', '-u', 'origin', 'main']);
  gitOk(cloneDir, ['fetch', '-q', 'origin']);

  const stateDir = mktemp('we-daemon-rebuild-fb-state-');
  const lockDir = mktemp('we-daemon-rebuild-fb-lock-');
  const overlayDir = mktemp('we-daemon-rebuild-fb-overlay-');
  const env = {
    ...process.env,
    WE_DAEMON_STATE_DIR: stateDir,
    WE_DAEMON_CLONE_LOCK_ROOT: lockDir,
    WE_DAEMON_OVERLAY_DIR: overlayDir,
  };
  delete env.LANE_POOL_ROOT;
  delete env[DISPATCH_CWD_ROOT_ENV];
  return {
    base, originDir, cloneDir, stateDir, lockDir, overlayDir, env,
  };
}

const LOCK_OPTS = { waitMs: 2000, pollMs: 20 };

beforeEach(() => {
  tempDirs.length = 0;
});

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});


const RULINGS = '## R508 — x\nOperator "Yes": adopt the build even though smoke failed for infra.\n';
const QUOTE = 'adopt the build even though smoke failed for infra';
const failing = () => vi.fn(async () => ({ verdict: 'code', attempts: 1, smoke: { results: [{ ok: false, name: 'daemon-entries-boot', detail: 'boom', mayBeTransient: false }] } }));
const headOf = (dir) => gitOk(dir, ['rev-parse', 'HEAD']).trim();
const forceEnv = (env, base) => ({ ...env, WE_FORCE_ADOPT_HANDOFF: join(base, 'handoff.md'), WE_FORCE_ADOPT_CORONER: join(base, 'coroner.jsonl'), WE_DAEMON_EVENTS: join(base, 'events.jsonl') });

describe('R508 force-adopt through rebuildClone', () => {
  it('without a force request a failed smoke still holds on last-good (unchanged)', async () => {
    const { originDir, cloneDir, env } = makeFixture();
    env.WE_DAEMON_HARNESS_BROKEN_ADOPT_NOT_WORSE = '0';
    const before = headOf(cloneDir);
    advanceMain(originDir, (dir) => writeFile(dir, 'm.txt', 'x\n'));
    const r = await rebuildClone({ root: cloneDir, env, runSmoke: failing(), prState: async () => null, lockOpts: LOCK_OPTS });
    expect(r.moved).not.toBe(true);
    expect(headOf(cloneDir)).toBe(before);
  });

  it('a request without a ruling is refused and changes nothing', () => {
    const { cloneDir, env } = makeFixture();
    expect(requestForceAdopt({ root: cloneDir, env, daemon: 'review', quote: QUOTE, rulingsText: RULINGS }).ok).toBe(false);
    expect(readForceAdopt(cloneDir, env)).toBeNull();
  });

  it('with ruling+quote: the smoke runs, the failed build is adopted, logged, coroner-recorded, and the watch rolls it back on bad health', async () => {
    const { base, originDir, cloneDir, env: env0 } = makeFixture();
    const env = forceEnv(env0, base);
    const lastGood = headOf(cloneDir);
    advanceMain(originDir, (dir) => writeFile(dir, 'm.txt', 'x\n'));
    expect(requestForceAdopt({ root: cloneDir, env, daemon: 'review', ruling: 'R508', quote: QUOTE, rulingsText: RULINGS }).ok).toBe(true);
    const runSmoke = failing();
    const r = await rebuildClone({ root: cloneDir, env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS });
    expect(runSmoke).toHaveBeenCalled(); // smoke is never skipped
    expect(r.moved).toBe(true);
    expect(headOf(cloneDir)).not.toBe(lastGood);
    expect(readFileSync(env.WE_FORCE_ADOPT_HANDOFF, 'utf8')).toMatch(/FORCE-ADOPT.*R508.*daemon-entries-boot|FORCE-ADOPT.*R508/s);
    expect(readFileSync(env.WE_FORCE_ADOPT_CORONER, 'utf8')).toMatch(/force-adopt-review/);
    expect(readFileSync(env.WE_DAEMON_EVENTS, 'utf8')).toMatch(/"kind":"force-adopt"/);
    expect(readForceAdopt(cloneDir, env)).toBeNull(); // one-shot
    expect(readForceWatch(cloneDir, env)).not.toBeNull(); // opened now, first checked on the NEXT tick
    expect(headOf(cloneDir)).not.toBe(lastGood);

    // next tick: health fails -> reverted to the last-good build
    await rebuildClone({ root: cloneDir, env, runSmoke: vi.fn(async () => ({ verdict: 'pass', attempts: 1, smoke: { results: [] } })),
      prState: async () => null, lockOpts: LOCK_OPTS, forceWatchProbe: async () => ({ healthy: false }) });
    expect(headOf(cloneDir)).toBe(lastGood);
    expect(readForceWatch(cloneDir, env)).toBeNull();
    expect(readFileSync(env.WE_DAEMON_EVENTS, 'utf8')).toMatch(/force-adopt-rolled-back/);
  });
});
