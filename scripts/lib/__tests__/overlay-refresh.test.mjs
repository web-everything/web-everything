/** Refresh API: settings -> {autoRefresh, sources:{autoRefresh}}.
 * refreshStaleOverlay({root, overlay, mainSha, env, settings, alert, run, createScratch, push})
 * -> {ok, ref?, from?, sha?, files?, reason?}; createScratch({root}) -> {root, cleanup};
 * run(args, opts) and push({root, ref, sha}) return gitRun process results.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, chmodSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { addOverlay, readOverlays, writeOverlays, overlayFilePath } from '../daemon-overlays.mjs';
import { gitRun } from '../main-staleness.mjs';
import { createOverlayScratch, resolveOverlayRefreshSettings, refreshStaleOverlay } from '../daemon-rebuild/overlay-refresh.mjs';

const dirs = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'we-overlay-refresh-test-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function git(root, args) {
  const r = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', ...args], {
    cwd: root, encoding: 'utf8', timeout: 20_000,
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const success = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const failure = (stderr) => ({ status: 1, stdout: '', stderr });

function fixture({ conflict = true, ref = 'lane/guards' } = {}) {
  const base = temp(), origin = join(base, 'origin.git'), author = join(base, 'author'), root = join(base, 'daemon');
  git(base, ['init', '--bare', '-q', origin]);
  git(base, ['init', '-q', '-b', 'main', author]);
  writeFileSync(join(author, 'guard.txt'), 'limit=10\n');
  git(author, ['add', '.']); git(author, ['commit', '-qm', 'base']);
  git(author, ['remote', 'add', 'origin', origin]); git(author, ['push', '-qu', 'origin', 'main']);
  git(base, ['--git-dir', origin, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(author, ['checkout', '-qb', ref]);
  writeFileSync(join(author, 'guard.txt'), 'limit=5\n');
  git(author, ['commit', '-qam', 'overlay stricter limit']); git(author, ['push', '-q', 'origin', ref]);
  const topSha = git(author, ['rev-parse', 'HEAD']);
  git(author, ['checkout', '-q', 'main']);
  writeFileSync(join(author, conflict ? 'guard.txt' : 'main.txt'), conflict ? 'limit=3\n' : 'main addition\n');
  git(author, ['add', '.']); git(author, ['commit', '-qm', 'main advances']); git(author, ['push', '-q', 'origin', 'main']);
  git(base, ['clone', '-q', origin, root]); git(root, ['fetch', '-q', 'origin']);
  const mainSha = git(root, ['rev-parse', 'origin/main']);
  const env = { ...process.env, WE_DAEMON_OVERLAY_DIR: join(base, 'overlays'), WE_PLATFORM_PREFERENCES_FILE: join(base, 'platform.json') };
  writeFileSync(env.WE_PLATFORM_PREFERENCES_FILE, '{}');
  addOverlay(root, { ref, pr: 6386, addedBy: 'operator', reason: 'preserve guards', pinned: true, stackBases: ['lane/base'] }, { env });
  const overlay = readOverlays(root, { env })[0];
  const alert = vi.fn();
  const createScratch = vi.fn(({ root: source }) => {
    const scratch = join(temp(), 'scratch');
    git(base, ['clone', '-q', '--shared', source, scratch]);
    git(scratch, ['remote', 'set-url', 'origin', origin]); git(scratch, ['fetch', '-q', 'origin']);
    return { root: scratch, cleanup: vi.fn(() => rmSync(scratch, { recursive: true, force: true })) };
  });
  // A clean scratch merge after a status-1 preflight can occur if the probe was conservative.
  // Inject only that probe for the clean path; the scratch merge and pushed commits are real git.
  const run = vi.fn((args, opts) => !conflict && args.includes('merge-tree')
    ? { status: 1, stdout: '', stderr: '' } : gitRun(args, opts));
  const push = vi.fn(({ root: scratch, ref: next, sha }) => gitRun(['push', 'origin', `${sha}:refs/heads/${next}`], { cwd: scratch }));
  const settings = { autoRefresh: true, sources: { autoRefresh: 'standard' } };
  const opts = { root, overlay, mainSha, env, settings, alert, run, createScratch, push };
  const target = `${ref.replace(/-mainsync-[a-f0-9]+$/i, '')}-mainsync-${mainSha.slice(0, 7)}`;
  return { ...opts, opts, base, origin, author, topSha, target };
}
function expectFailed(f, r, files = ['guard.txt']) {
  expect(r).toMatchObject({ ok: false, files, reason: expect.any(String) });
  expect(readOverlays(f.root, { env: f.env })).toEqual([f.overlay]);
  expect(f.alert).toHaveBeenCalledWith('overlay-refresh-failed', expect.objectContaining({ ref: f.overlay.ref, files, reason: expect.any(String) }));
  expect(f.alert.mock.calls.map(([kind]) => kind)).not.toContain('overlay-refreshed');
}
function settingsFixture(tool = {}, platform = {}) {
  const base = temp(), settingsPath = join(base, 'settings.json'), platformPath = join(base, 'platform.json');
  writeFileSync(settingsPath, JSON.stringify({ overlay: tool }));
  writeFileSync(platformPath, JSON.stringify({ overlay: platform }));
  return { settingsPath, env: { WE_PLATFORM_PREFERENCES_FILE: platformPath } };
}

describe('resolveOverlayRefreshSettings', () => {
  it('defaults on and logs the standard source for each leaf', () => {
    const f = settingsFixture();
    expect(resolveOverlayRefreshSettings(f.env, f)).toEqual({ autoRefresh: true, sources: { autoRefresh: 'standard' } });
  });
  it('resolves platform then tool then env independently with sources', () => {
    const f = settingsFixture({}, { autoRefresh: false });
    expect(resolveOverlayRefreshSettings(f.env, f)).toMatchObject({ autoRefresh: false, sources: { autoRefresh: 'platform' } });
    expect(resolveOverlayRefreshSettings({ ...f.env, WE_DAEMON_OVERLAY_AUTO_REFRESH: '1' }, f)).toMatchObject({ autoRefresh: true, sources: { autoRefresh: 'env' } });
    expect(resolveOverlayRefreshSettings({ ...f.env, WE_DAEMON_OVERLAY_AUTO_REFRESH: 'false' }, f)).toMatchObject({ autoRefresh: false, sources: { autoRefresh: 'env' } });
  });
  it('ignores invalid values at every layer', () => {
    const f = settingsFixture({ autoRefresh: 'yes' }, { autoRefresh: 7 });
    expect(resolveOverlayRefreshSettings({ ...f.env, WE_DAEMON_OVERLAY_AUTO_REFRESH: 'maybe' }, f)).toEqual({ autoRefresh: true, sources: { autoRefresh: 'standard' } });
  });
});

describe('refreshStaleOverlay', () => {
  it('never probes a partially configured scratch after setup fails, and cleans it', async () => {
    const f = fixture();
    const run = vi.fn((args, opts) => args.includes('set-url')
      ? failure('origin setup failed') : gitRun(args, opts));
    const session = createOverlayScratch({ root: f.root, env: f.env, run });
    try {
      await expect(session.git()).rejects.toThrow('Scratch origin setup failed');
      await expect(session.git()).rejects.toThrow('Scratch origin setup failed');
      expect(run.mock.calls.filter(([args]) => args.includes('clone'))).toHaveLength(1);
      expect(run.mock.calls.some(([args]) => args.includes('merge-tree'))).toBe(false);
    } finally { await session.cleanup(); }
    expect(existsSync(session.root)).toBe(false);
  });
  it('refuses a mismatched input pin before creating scratch or probing', async () => {
    const f = fixture();
    f.overlay.pinnedSha = f.mainSha;
    writeOverlays(f.root, [f.overlay], { env: f.env });
    expectFailed(f, await refreshStaleOverlay(f.opts), []);
    expect(f.createScratch).not.toHaveBeenCalled();
    expect(f.run.mock.calls.some(([args]) => args.includes('merge-tree'))).toBe(false);
    expect(f.push).not.toHaveBeenCalled();
  });
  it('never overwrites a registry pin changed while refresh was publishing', async () => {
    const f = fixture({ conflict: false });
    const publish = f.push.getMockImplementation();
    f.push.mockImplementation((args) => {
      writeOverlays(f.root, [{ ...f.overlay, pinnedSha: f.mainSha }], { env: f.env });
      return publish(args);
    });
    const result = await refreshStaleOverlay(f.opts);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('Overlay registry changed') });
    expect(readOverlays(f.root, { env: f.env })).toEqual([{ ...f.overlay, pinnedSha: f.mainSha }]);
    expect(f.alert).toHaveBeenCalledWith('overlay-refresh-failed', expect.any(Object));
  });
  it('runs real preflight only in hardened scratch, with daemon merge drivers unreachable', async () => {
    const f = fixture();
    const sentinel = join(f.base, 'driver-ran');
    git(f.root, ['config', 'merge.evil.driver', `touch ${sentinel}`]);
    writeFileSync(join(f.root, '.git', 'info', 'attributes'), '* merge=evil\n');
    expectFailed(f, await refreshStaleOverlay({ ...f.opts, createScratch: undefined }));
    const probes = f.run.mock.calls.filter(([args]) => args.includes('merge-tree'));
    expect(probes).toHaveLength(1);
    for (const [args, opts] of probes) {
      expect(opts.cwd).not.toBe(f.root);
      expect(args).toContain('core.hooksPath=/dev/null');
      expect(args).toContain('core.attributesFile=/dev/null');
      expect(opts.env).toMatchObject({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
      expect(existsSync(opts.cwd)).toBe(false);
    }
    expect(existsSync(sentinel)).toBe(false);
  });
  it('clean merge registers a new ref, preserves metadata and old git ref, records event and settings sources', async () => {
    const f = fixture({ conflict: false });
    const r = await refreshStaleOverlay(f.opts);
    expect(r).toMatchObject({ ok: true, from: f.overlay.ref, ref: f.target, sha: expect.stringMatching(/^[a-f0-9]{40}$/) });
    expect(readOverlays(f.root, { env: f.env })).toEqual([{ ...f.overlay, ref: f.target, pinnedSha: r.sha, refreshedFrom: [f.overlay.ref] }]);
    expect(git(f.base, ['--git-dir', f.origin, 'rev-list', '--parents', '-n', '1', r.sha]).split(' ')).toEqual([r.sha, f.topSha, f.mainSha]);
    expect(git(f.base, ['--git-dir', f.origin, 'rev-parse', `refs/heads/${f.overlay.ref}`])).toBe(f.topSha);
    expect(git(f.base, ['--git-dir', f.origin, 'rev-parse', `refs/heads/${f.target}`])).toBe(r.sha);
    expect(git(f.base, ['--git-dir', f.origin, 'show', `${r.sha}:guard.txt`])).toBe('limit=5');
    expect(git(f.base, ['--git-dir', f.origin, 'show', `${r.sha}:main.txt`])).toBe('main addition');
    const events = readFileSync(overlayFilePath(f.root, f.env).replace(/\.json$/, '.events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'refreshed', from: f.overlay.ref, to: f.target }));
    expect(f.alert).toHaveBeenCalledWith('overlay-refreshed', expect.objectContaining({ ref: f.target, from: f.overlay.ref, mainSha: f.mainSha, via: 'clean' }));
    expect(f.alert).toHaveBeenCalledWith('overlay-refresh-settings', expect.objectContaining(f.settings));
  });
  it('conflicts only alert and list unmerged index paths, with no worker or push', async () => {
    const f = fixture();
    expectFailed(f, await refreshStaleOverlay(f.opts));
    expect(f.push).not.toHaveBeenCalled();
    const scratchCalls = f.run.mock.calls.filter(([, opts]) => opts.cwd !== f.root);
    expect(scratchCalls.some(([args]) => args.includes('--diff-filter=U'))).toBe(true);
    expect(scratchCalls.every(([args]) => args[0] === '-c')).toBe(true);
    expect(scratchCalls.some(([args]) => args.some((arg) => /codex|task-file|review/.test(arg)))).toBe(false);
  });
  it('does not execute hooks, filters, custom merge drivers or fsmonitor in scratch', async () => {
    const f = fixture({ conflict: false });
    const sentinel = join(f.base, 'executed');
    const hookDir = join(f.base, 'hooks'); mkdirSync(hookDir);
    for (const name of ['post-checkout', 'pre-merge-commit', 'prepare-commit-msg', 'commit-msg', 'post-merge', 'pre-push']) {
      const hook = join(hookDir, name);
      writeFileSync(hook, `#!/bin/sh\ntouch '${sentinel}'\nexit 1\n`); chmodSync(hook, 0o755);
    }
    const create = f.createScratch.getMockImplementation();
    f.createScratch.mockImplementation((args) => {
      const scratch = create(args);
      git(scratch.root, ['config', 'core.hooksPath', hookDir]);
      git(scratch.root, ['config', 'core.fsmonitor', `touch ${sentinel}`]);
      git(scratch.root, ['config', 'filter.evil.smudge', `touch ${sentinel}`]);
      git(scratch.root, ['config', 'merge.evil.driver', `touch ${sentinel}`]);
      writeFileSync(join(scratch.root, '.git', 'info', 'attributes'), '* filter=evil merge=evil\n');
      return scratch;
    });
    // Use the production default push, which must disable pre-push hooks too.
    expect((await refreshStaleOverlay({ ...f.opts, push: undefined })).ok).toBe(true);
    expect(existsSync(sentinel)).toBe(false);
    for (const [args, opts] of f.run.mock.calls.filter(([, opts]) => opts.cwd !== f.root)) {
      expect(args).toContain('core.hooksPath=/dev/null');
      expect(args).toContain('core.fsmonitor=false');
      expect(opts.env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    }
  });
  it('does not scan marker-like tracked text for conflict evidence', async () => {
    const f = fixture({ conflict: false });
    const create = f.createScratch.getMockImplementation();
    f.createScratch.mockImplementation((args) => {
      const scratch = create(args);
      // An untracked marker string cannot substitute for the index conflict list.
      writeFileSync(join(scratch.root, 'markers.txt'), '<<<<<<< example\n');
      return scratch;
    });
    expect((await refreshStaleOverlay(f.opts)).ok).toBe(true);
  });
  it('push failure keeps the stale registry entry', async () => {
    const f = fixture({ conflict: false }); f.push.mockReturnValue(failure('permission denied'));
    expectFailed(f, await refreshStaleOverlay(f.opts), []);
  });
  it('reuses a target branch already at the identical merge sha without pushing again', async () => {
    const f = fixture({ conflict: false });
    const first = await refreshStaleOverlay(f.opts);
    expect(first.ok).toBe(true);
    writeOverlays(f.root, [f.overlay], { env: f.env });
    f.push.mockClear();
    const r = await refreshStaleOverlay(f.opts);
    expect(r).toMatchObject({ ok: true, ref: f.target, sha: first.sha });
    expect(f.push).not.toHaveBeenCalled();
    expect(git(f.base, ['--git-dir', f.origin, 'rev-parse', `refs/heads/${f.target}`])).toBe(r.sha);
  });
  it('uses a disposable production scratch checkout with hooks off on clone and every scratch call', async () => {
    const f = fixture({ conflict: false });
    const before = git(f.root, ['show-ref']);
    const r = await refreshStaleOverlay({ ...f.opts, createScratch: undefined, push: undefined });
    expect(r.ok).toBe(true);
    expect(git(f.root, ['show-ref'])).toBe(before);
    const calls = f.run.mock.calls.filter(([, opts]) => opts.cwd !== f.root);
    expect(calls.some(([args]) => args.includes('clone') && args.includes('--no-checkout'))).toBe(true);
    for (const [args] of calls) {
      expect(args).toContain('core.hooksPath=/dev/null');
      expect(args).toContain('core.fsmonitor=false');
    }
  });
  it('rejects every non-zero merge exit even without unmerged index paths', async () => {
    const f = fixture({ conflict: false });
    const run = f.run.getMockImplementation();
    f.run.mockImplementation((args, opts) => args.includes('merge') ? failure('merge refused') : run(args, opts));
    expectFailed(f, await refreshStaleOverlay(f.opts), []);
    expect(f.push).not.toHaveBeenCalled();
  });
  it.each(['wrong-order', 'extra-parent'])('refuses unexpected merge parents: %s', async (kind) => {
    const f = fixture({ conflict: false });
    const run = f.run.getMockImplementation();
    f.run.mockImplementation((args, opts) => args.includes('rev-list')
      ? success(kind === 'wrong-order' ? `HEAD ${f.mainSha} ${f.topSha}` : `HEAD ${f.topSha} ${f.mainSha} ${f.mainSha}`)
      : run(args, opts));
    expectFailed(f, await refreshStaleOverlay(f.opts), []);
    expect(f.push).not.toHaveBeenCalled();
  });
  it('refuses an existing target at a different sha even if a fast-forward push would succeed', async () => {
    const f = fixture({ conflict: false });
    git(f.author, ['push', '-q', 'origin', `${f.mainSha}:refs/heads/${f.target}`]);
    const r = await refreshStaleOverlay(f.opts);
    expectFailed(f, r, []);
    expect(git(f.base, ['--git-dir', f.origin, 'rev-parse', `refs/heads/${f.target}`])).toBe(f.mainSha);
    expect(f.push).not.toHaveBeenCalled();
  });
  it('does no scratch work when autoRefresh is disabled', async () => {
    const f = fixture(); f.settings.autoRefresh = false;
    await refreshStaleOverlay(f.opts);
    expect(f.createScratch).not.toHaveBeenCalled();
 expect(f.push).not.toHaveBeenCalled();
    expect(readOverlays(f.root, { env: f.env })).toEqual([f.overlay]);
  });
  it('cleans scratch after a conflict and never force-pushes', async () => {
    const f = fixture();
    expectFailed(f, await refreshStaleOverlay(f.opts));
    const scratch = f.createScratch.mock.results[0].value;
    expect(scratch.cleanup).toHaveBeenCalledTimes(1); expect(existsSync(scratch.root)).toBe(false);
    for (const [args] of f.run.mock.calls) {
      expect(args.some((a) => /^--force(?:=|$)|^--force-with-lease(?:=|$)|^\+.*:/.test(a))).toBe(false);
    }
  });
  it('strips the existing mainsync suffix', async () => {
    const f = fixture({ ref: 'lane/guards-mainsync-abcdef0', conflict: false });
    expect(await refreshStaleOverlay(f.opts)).toMatchObject({ ok: true, ref: f.target });
    expect(f.target).toBe(`lane/guards-mainsync-${f.mainSha.slice(0, 7)}`);
  });
  it.each([0, 2, 128])('does not refresh when merge-tree returns %s (only status 1 proves conflict)', async (status) => {
    const f = fixture();
    f.run.mockImplementation((args, opts) => args.includes('merge-tree') ? { status, stdout: '', stderr: '' } : gitRun(args, opts));
    const result = await refreshStaleOverlay(f.opts);
    if (status === 0) expect(result).toMatchObject({ ok: true, refreshed: false });
    else expectFailed(f, result, []);
    expect(f.createScratch).toHaveBeenCalledTimes(1);
    const scratch = f.createScratch.mock.results[0].value;
    expect(scratch.cleanup).toHaveBeenCalledTimes(1);
    expect(f.run.mock.calls.some(([args]) => args.includes('merge') || args.includes('checkout'))).toBe(false);
    expect(f.push).not.toHaveBeenCalled();
    expect(readOverlays(f.root, { env: f.env })).toEqual([f.overlay]);
  });
  it('never mutates daemon checkout, index or refs and cleans scratch after completion', async () => {
    const f = fixture({ conflict: false });
    const snapshot = () => ({ head: git(f.root, ['rev-parse', 'HEAD']), refs: git(f.root, ['show-ref']), status: git(f.root, ['status', '--porcelain']), index: readFileSync(join(f.root, '.git', 'index')).toString('hex'), guard: readFileSync(join(f.root, 'guard.txt'), 'utf8') });
    const before = snapshot();
    const originalRun = f.run.getMockImplementation();
    f.run.mockImplementation((args, opts) => {
      if (opts?.cwd === f.root) expect(['rev-parse', 'show', 'diff', 'log', 'status', 'ls-remote', 'merge-base', 'config', 'remote']).toContain(args[0]);
      return originalRun(args, opts);
    });
    expect((await refreshStaleOverlay(f.opts)).ok).toBe(true);
    expect(snapshot()).toEqual(before);
    const scratch = f.createScratch.mock.results[0].value;
    expect(scratch.root.startsWith(f.root)).toBe(false);
    expect(realpathSync(join(scratch.root, '..')).startsWith(realpathSync(tmpdir()))).toBe(true);
    expect(scratch.cleanup).toHaveBeenCalled(); expect(existsSync(scratch.root)).toBe(false);
  });
});
