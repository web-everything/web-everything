/** @file xhiqxz3 — the daemon's TICK rebuild runs the real dispatch smoke (#4481's) inside its candidate smoke, so
 * an overlay that breaks the worker launch is never adopted. Real-git fixtures; the worker launch is injected. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { rebuildClone, readRebuildState } from '../daemon-rebuild.mjs';
import { addOverlay, readOverlayState } from '../daemon-overlays.mjs';
import { dispatchSmokeSuspects } from '../daemon-rebuild/smoke.mjs';

process.env.WE_DAEMON_REBUILD_SKIP_UNRELATED = '0';

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
function writeFile(dir, name, content) {
  const full = join(dir, name);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}
function pushBranch(originDir, ref, mutate, from = 'origin/main') {
  const dir = join(mktemp('we-rebuild-dsmoke-author-'), 'w');
  const r = spawnSync('git', ['clone', '-q', originDir, dir], { encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL' });
  if (r.status !== 0) throw new Error(`clone failed: ${r.stderr}`);
  gitOk(dir, ['checkout', '-q', '-B', ref, from]);
  mutate(dir);
  gitOk(dir, ['add', '-A']);
  gitOk(dir, ['commit', '-q', '-m', `change: ${ref}`]);
  gitOk(dir, ['push', '-q', 'origin', `HEAD:refs/heads/${ref}`]);
  return gitOk(dir, ['rev-parse', 'HEAD']).trim();
}

function makeFixture() {
  const base = mktemp('we-rebuild-dsmoke-fixture-');
  const originDir = join(base, 'origin.git');
  const cloneDir = join(base, 'clone');
  mkdirSync(cloneDir, { recursive: true });
  gitOk(base, ['init', '--bare', '-q', originDir]);
  gitOk(cloneDir, ['init', '-q', '-b', 'main']);
  writeFile(cloneDir, 'README.md', 'init\n');
  writeFile(cloneDir, 'scripts/operations/dispatch-lane-io.mjs', 'export const v = 1;\n');
  gitOk(cloneDir, ['add', '-A']);
  gitOk(cloneDir, ['commit', '-q', '-m', 'init']);
  gitOk(cloneDir, ['remote', 'add', 'origin', originDir]);
  gitOk(cloneDir, ['push', '-q', '-u', 'origin', 'main']);
  gitOk(cloneDir, ['fetch', '-q', 'origin']);
  const env = {
    ...process.env,
    WE_DAEMON_STATE_DIR: mktemp('we-rebuild-dsmoke-state-'),
    WE_DAEMON_CLONE_LOCK_ROOT: mktemp('we-rebuild-dsmoke-lock-'),
    WE_DAEMON_OVERLAY_DIR: mktemp('we-rebuild-dsmoke-overlay-'),
  };
  return { originDir, cloneDir, env };
}

const LOCK_OPTS = { waitMs: 1500, pollMs: 20 };
const PASS = { verdict: 'pass', attempts: 1, smoke: { results: [] } };
const SETTINGS = {
  dispatchSmoke: 'on', dispatchPaths: ['scripts/operations/dispatch-lane-io.mjs'], noPr: 'warn', smokeTimeoutMs: 60_000, smokeKind: 'ci-heal',
};
const head = (f) => gitOk(f.cloneDir, ['rev-parse', 'HEAD']).trim();
const rebuild = (f, run, { settings = SETTINGS, runSmoke = vi.fn(async () => PASS) } = {}) => rebuildClone({
  root: f.cloneDir, env: f.env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
  dispatchSmoke: { settings, run },
});
function addDispatchOverlay(f, ref = 'lane/s3b', file = 'scripts/operations/dispatch-lane-io.mjs') {
  const sha = pushBranch(f.originDir, ref, (dir) => writeFile(dir, file, `export const v = '${ref}';\n`));
  addOverlay(f.cloneDir, { ref, pr: 77, addedBy: 't' }, { env: f.env });
  return sha;
}
const refs = (f) => readOverlayState(f.cloneDir, { env: f.env }).overlays.map((o) => o.ref);

beforeEach(() => { tempDirs.length = 0; });
afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

describe('xhiqxz3 — dispatch smoke inside the tick rebuild', () => {
  it('a candidate whose new overlay fails the dispatch smoke is never adopted; the clone stays on last-good', async () => {
    const f = makeFixture();
    const lastGood = head(f);
    addOverlay(f.cloneDir, { ref: 'lane/other', pr: 5, addedBy: 't' }, { env: f.env });
    pushBranch(f.originDir, 'lane/other', (dir) => writeFile(dir, 'other.txt', 'x'));
    addDispatchOverlay(f);
    const run = vi.fn(async () => ({ ok: false, reason: 'commands-denied', detail: 'This command requires approval' }));
    const r = await rebuild(f, run);
    expect(run).toHaveBeenCalledTimes(1);
    // It smokes the CANDIDATE worktree, never the live clone.
    expect(run.mock.calls[0][0].tree).not.toBe(f.cloneDir);
    expect(r.adopted).toBeFalsy();
    expect(r.reason).toBe('dispatch-smoke-failed');
    expect(head(f)).toBe(lastGood);
    const st = readRebuildState(f.cloneDir, f.env);
    expect(st.held.reason).toBe('dispatch-smoke-failed');
    // Only the offending overlay is dropped; the other one stays registered.
    expect(refs(f)).toEqual(['lane/other']);
    expect(r.alerts.map((a) => a.kind)).toContain('dispatch-smoke-failed');
    // The next tick builds main + the remaining overlay, with no dispatch smoke needed.
    const run2 = vi.fn(async () => ({ ok: true, reason: 'passed' }));
    const r2 = await rebuild(f, run2);
    expect(r2.adopted).toBe(true);
    expect(run2).not.toHaveBeenCalled();
  });

  it('a passing dispatch smoke adopts, and an unchanged overlay is not smoked again', async () => {
    const f = makeFixture();
    const sha = addDispatchOverlay(f);
    const run = vi.fn(async () => ({ ok: true, reason: 'passed', ms: 5 }));
    const r = await rebuild(f, run);
    expect(r.adopted).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(r.alerts.map((a) => a.kind)).toContain('dispatch-smoke-passed');
    gitOk(f.cloneDir, ['merge-base', '--is-ancestor', sha, 'HEAD']);
    pushBranch(f.originDir, 'main', (dir) => writeFile(dir, 'b.txt', 'b'));
    const r2 = await rebuild(f, run);
    expect(r2.adopted).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a timeout holds on last-good, keeps the overlay, and retries with backoff', async () => {
    const f = makeFixture();
    const lastGood = head(f);
    addDispatchOverlay(f);
    const run = vi.fn(async () => ({ ok: false, reason: 'timeout', detail: 'no command ran and no completion record' }));
    const r = await rebuild(f, run);
    expect(r.adopted).toBeFalsy();
    expect(head(f)).toBe(lastGood);
    expect(refs(f)).toEqual(['lane/s3b']);
    const st = readRebuildState(f.cloneDir, f.env);
    expect(st.rejected.dispatchSmoke).toBe(true);
    expect(Date.parse(st.rejected.retryAt)).toBeGreaterThan(Date.now());
    const r2 = await rebuild(f, run);
    expect(r2.reason).toBe('still-rejected');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('an overlay off the dispatch path, or the setting off, never launches a worker', async () => {
    const f = makeFixture();
    addDispatchOverlay(f, 'lane/docs', 'docs/x.md');
    const run = vi.fn();
    expect((await rebuild(f, run)).adopted).toBe(true);
    const g = makeFixture();
    addDispatchOverlay(g);
    expect((await rebuild(g, run, { settings: { ...SETTINGS, dispatchSmoke: 'off' } })).adopted).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  const FAIL = { verdict: 'code', attempts: 1, smoke: { results: [{ ok: false, name: 'x', detail: 'boom' }] } };
  it('a failing ordinary smoke never reaches the dispatch smoke (plain main passes and is adopted)', async () => {
    const f = makeFixture();
    addDispatchOverlay(f);
    const run = vi.fn();
    const runSmoke = vi.fn().mockResolvedValueOnce(FAIL).mockResolvedValue(PASS);
    const r = await rebuild(f, run, { runSmoke });
    expect(r.reason).toBe('fallback-plain-main');
    expect(run).not.toHaveBeenCalled();
  });

  it('adopting a candidate "as no worse" (harness broken) still requires the dispatch smoke', async () => {
    const f = makeFixture();
    const lastGood = head(f);
    addDispatchOverlay(f);
    const run = vi.fn(async () => ({ ok: false, reason: 'no-commands-ran' }));
    const r = await rebuild(f, run, { runSmoke: vi.fn(async () => FAIL) });
    expect(run).toHaveBeenCalledTimes(1);
    expect(r.reason).toBe('dispatch-smoke-failed');
    expect(head(f)).toBe(lastGood);
  });
});

describe('dispatchSmokeSuspects', () => {
  const match = (files, pats) => files.filter((x) => pats.includes(x));
  const okGit = (files) => (args) => (args[0] === 'merge-base' ? { status: 0, stdout: 'base\n' } : { status: 0, stdout: files.join('\n') });
  it('skips an overlay already adopted at the same sha, and fails closed on an unreadable diff', () => {
    const applied = [{ ref: 'a', sha: '1' }, { ref: 'b', sha: '2' }];
    expect(dispatchSmokeSuspects({
      git: okGit(['p']), applied, adoptedApplied: [{ ref: 'a', sha: '1' }], patterns: ['p'], match,
    }).map((s) => s.ref)).toEqual(['b']);
    expect(dispatchSmokeSuspects({
      git: () => ({ status: 1 }), applied, adoptedApplied: null, patterns: ['p'], match,
    }).map((s) => s.reason)).toEqual(['diff-unknown', 'diff-unknown']);
    expect(dispatchSmokeSuspects({
      git: okGit(['q']), applied, adoptedApplied: null, patterns: ['p'], match,
    })).toEqual([]);
  });
});
