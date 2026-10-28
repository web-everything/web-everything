import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { kickOverlayMainSync, runOverlayMainSync, selectSyncTargets, resolveOverlayMainSyncMode } from '../daemon-rebuild/overlay-main-sync.mjs';
import { addOverlay, readOverlayState, overlayFilePath, appendOverlayEvent } from '../daemon-overlays.mjs';
import { alertsFilePath } from '../daemon-rebuild/state.mjs';
import { readOverlayConflictWakes } from '../overlay-conflict-wake.mjs';

const temps = [], ref = 'lane/fix';
const temp = () => { const p = fs.mkdtempSync(join(tmpdir(), 'we-main-sync-test-')); temps.push(p); return p; };
afterEach(() => { vi.restoreAllMocks(); temps.splice(0).forEach(p => fs.rmSync(p, { recursive: true, force: true })); });
const run = (args, opts = {}) => spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args],
  { encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024, ...opts, env: { ...process.env, ...opts.env } });
const ok = (cwd, args) => { const r = run(args, { cwd }); if (r.status !== 0) throw new Error(`${args}: ${r.stderr}`); return r.stdout.trim(); };
const write = (root, file, text) => { fs.mkdirSync(dirname(join(root, file)), { recursive: true }); fs.writeFileSync(join(root, file), text); };
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sidecar = f => `${overlayFilePath(f.root, f.env)}.main-sync.json`;
const marker = f => join(`${overlayFilePath(f.root, f.env)}.auto-rebase`, `${encodeURIComponent(ref)}.lock`);
const synced = f => f.events.filter(e => e.kind === 'overlay-main-synced');
const alerts = f => fs.readFileSync(alertsFilePath(f.root, f.env), 'utf8').trim().split('\n').map(JSON.parse)
  .filter(e => e.kind.includes('needs-you'));

function fixture({ conflict = false, unrelated = false, count = 1 } = {}) {
  const base = temp(), root = join(base, 'clone'), origin = join(base, 'origin.git');
  fs.mkdirSync(root); fs.mkdirSync(join(root, 'node_modules'));
  ok(root, ['init', '-q', '-b', 'main']);
  write(root, '.gitignore', 'node_modules/\n');
  const lines = Array.from({ length: 30 }, (_, i) => `export const value${i} = ${i};`);
  write(root, 'worker.mjs', `${lines.join('\n')}\n`);
  write(root, 'unrelated.mjs', 'export default 0;\n');
  for (let i = 0; i < count; i++) write(root, `worker${i}.test.mjs`, "import './worker.mjs';\n");
  ok(root, ['add', '.']); ok(root, ['commit', '-qm', 'base']);
  const baseSha = ok(root, ['rev-parse', 'HEAD']);
  ok(root, ['checkout', '-qb', ref]);
  const branch = [...lines]; branch[0] = 'export const value0 = 100;';
  write(root, 'worker.mjs', `${branch.join('\n')}\n`);
  write(root, 'overlay.test.mjs', "import './worker.mjs';\n");
  ok(root, ['add', '.']); ok(root, ['commit', '-qm', 'overlay']);
  const oldSha = ok(root, ['rev-parse', 'HEAD']);
  ok(root, ['checkout', '-q', 'main']);
  const main = [...lines]; main[conflict ? 0 : 29] = `export const value${conflict ? 0 : 29} = 200;`;
  write(root, unrelated ? 'unrelated.mjs' : 'worker.mjs', unrelated ? 'export default 1;\n' : `${main.join('\n')}\n`);
  ok(root, ['commit', '-qam', 'main advanced']);
  const mainSha = ok(root, ['rev-parse', 'HEAD']);
  // Seed a local remote without network IO; both heads and their objects are real.
  ok(base, ['clone', '-q', '--bare', root, origin]);
  ok(root, ['remote', 'add', 'origin', origin]);
  ok(root, ['update-ref', 'refs/remotes/origin/main', mainSha]);
  ok(root, ['update-ref', `refs/remotes/origin/${ref}`, oldSha]);
  const env = { ...process.env, TMPDIR: base, WE_DAEMON_OVERLAY_DIR: join(base, 'overlays'),
    WE_DAEMON_STATE_DIR: join(base, 'state'), WE_PLATFORM_PREFERENCES_FILE: join(base, 'missing'), WE_DAEMON_OVERLAY_MAIN_SYNC: 'on' };
  addOverlay(root, { ref, pr: 123 }, { env });
  const events = [], scratched = [], pushes = [];
  const deps = {
    io: { ...fs, mkdtempSync: prefix => { const p = fs.mkdtempSync(prefix); scratched.push(p); temps.push(p); return p; } },
    git: vi.fn((args, opts) => { if (args[0] === 'push') pushes.push([...args]); return run(args, opts); }),
    appendOverlayEvent: (root, event, opts) => { events.push(event); return appendOverlayEvent(root, event, opts); },
    testRunner: vi.fn(async ({ root: scratch, args }) => {
      const report = args.find(a => a.startsWith('--outputFile.json='));
      if (report) fs.writeFileSync(report.slice('--outputFile.json='.length), JSON.stringify({
        testResults: args.filter(a => /\.test\.mjs$/.test(a)).map(file => ({
          name: join(fs.realpathSync(scratch), file), assertionResults: [{ status: 'passed' }],
        })),
      }));
      return { status: 0, stdout: '', stderr: '' };
    }),
    now: () => new Date().toISOString(),
  };
  return { base, root, origin, env, baseSha, oldSha, mainSha, events, scratched, pushes, deps };
}
const job = f => runOverlayMainSync({ root: f.root, ref, env: f.env, deps: f.deps });
const tick = (f, extra = {}) => kickOverlayMainSync({ root: f.root, env: f.env, mode: 'on', git: f.deps.git, ...extra });
const unchanged = f => {
  expect(ok(f.root, ['rev-parse', 'HEAD'])).toBe(f.mainSha);
  expect(ok(f.root, ['status', '--porcelain'])).toBe('');
  expect(f.scratched.length).toBeGreaterThan(0);
  expect(f.scratched.every(p => !fs.existsSync(p))).toBe(true);
};

describe('overlay main sync', () => {
  it('clean merge pushes the same ref non-force and emits overlay-main-synced {ref,from,to,tests}', async () => {
    const f = fixture();
    await job(f);
    expect(f.pushes).toEqual([['push', 'origin', `HEAD:refs/heads/${ref}`]]);
    const to = ok(f.origin, ['rev-parse', `refs/heads/${ref}`]);
    expect(to).not.toBe(f.oldSha);
    expect(ok(f.origin, ['rev-list', '--parents', '-n', '1', to]).split(' ')).toEqual([to, f.oldSha, f.mainSha]);
    expect(synced(f)).toEqual([expect.objectContaining({ ref, from: f.oldSha, to,
      tests: expect.arrayContaining(['worker0.test.mjs', 'overlay.test.mjs']) })]);
    expect(f.deps.testRunner).toHaveBeenCalledOnce();
    expect(json(sidecar(f)).lastSyncedMain[ref]).toBe(f.mainSha);
    unchanged(f);
  });

  it('conflict -> no push, overlay-main-merge-conflict event + needs-you naming ref and files + conflict wake marked', async () => {
    const f = fixture({ conflict: true });
    await job(f).catch(() => {});
    expect(f.pushes).toEqual([]);
    expect(f.events).toContainEqual(expect.objectContaining({ kind: 'overlay-main-merge-conflict', ref, files: ['worker.mjs'] }));
    expect(alerts(f)).toEqual(expect.arrayContaining([expect.objectContaining({
      detail: expect.objectContaining({ ref, reason: expect.stringContaining('worker.mjs') }),
    })]));
    expect(readOverlayConflictWakes(f.env).get(123)).toMatchObject({ pr: 123, ref, files: ['worker.mjs'], clone: f.root });
    expect(f.deps.testRunner).not.toHaveBeenCalled();
    expect(synced(f)).toEqual([]);
    expect(ok(f.origin, ['rev-parse', ref])).toBe(f.oldSha);
    unchanged(f);
  });

  it('moved remote (push rejected) -> no synced event, lastSyncedMain unchanged', async () => {
    const f = fixture();
    fs.writeFileSync(sidecar(f), JSON.stringify({ lastSyncedMain: { [ref]: f.baseSha } }));
    const git = f.deps.git;
    f.deps.git = vi.fn((args, opts) => {
      if (args[0] !== 'push') return git(args, opts);
      f.pushes.push([...args]);
      // Advance the real remote independently, then let Git reject the non-fast-forward push.
      const tree = ok(f.origin, ['rev-parse', `${f.oldSha}^{tree}`]);
      const moved = ok(f.origin, ['commit-tree', tree, '-p', f.oldSha, '-m', 'concurrent writer']);
      ok(f.origin, ['update-ref', `refs/heads/${ref}`, moved, f.oldSha]);
      const result = run(args, opts); expect(result.status).not.toBe(0); return result;
    });
    await job(f).catch(() => {});
    expect(f.pushes).toHaveLength(1);
    expect(synced(f)).toEqual([]);
    expect(json(sidecar(f)).lastSyncedMain[ref]).toBe(f.baseSha);
    unchanged(f);
  });

  it('contained bases skipped', () => {
    const state = { corrupt: false, overlays: [{ ref: 'lane/base' }, { ref, stackBases: ['lane/base'] }, { ref: 'lane/solo' }] };
    expect(selectSyncTargets(state)).toEqual([ref, 'lane/solo']);
  });

  it('no run while the auto-rebase marker is held', async () => {
    const f = fixture(), spawnFn = vi.fn();
    fs.mkdirSync(dirname(marker(f)), { recursive: true }); fs.writeFileSync(marker(f), 'auto-rebase-owner');
    expect(await tick(f, { spawnFn })).toMatchObject({ started: [], skipped: [ref] });
    expect(spawnFn).not.toHaveBeenCalled();
    expect(fs.readFileSync(marker(f), 'utf8')).toBe('auto-rebase-owner');
  });

  it('>100 selected tests flags needs-you and does not push', async () => {
    const f = fixture({ count: 101 });
    await job(f).catch(() => {});
    expect(alerts(f).some(e => e.detail.ref === ref && /100/.test(e.detail.reason))).toBe(true);
    expect(f.pushes).toEqual([]); expect(f.deps.testRunner).not.toHaveBeenCalled();
    expect(synced(f)).toEqual([]); unchanged(f);
  });

  it("no trigger when main's new commits don't touch the overlay's files", async () => {
    const f = fixture({ unrelated: true }), spawnFn = vi.fn();
    expect(await tick(f, { spawnFn })).toMatchObject({ started: [], skipped: [ref] });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('shadow mode logs "would merge" and spawns nothing', async () => {
    const f = fixture(), spawnFn = vi.fn(), log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await tick(f, { mode: 'shadow', spawnFn })).toMatchObject({ started: [], would: [ref] });
    expect(log.mock.calls.flat().join('\n')).toContain(`overlay-main-sync would merge main into ${ref}`);
    expect(spawnFn).not.toHaveBeenCalled();
    const eventFile = overlayFilePath(f.root, f.env).replace(/\.json$/, '.events.jsonl');
    expect(fs.readFileSync(eventFile, 'utf8').trim().split('\n').map(JSON.parse))
      .toContainEqual(expect.objectContaining({ kind: 'overlay-main-sync-shadow', ref }));
  });

  it('mode cascade (default on, settings, env)', () => {
    const base = temp(), settingsPath = join(base, 'settings.json'), preferences = join(base, 'preferences.json');
    const env = { WE_PLATFORM_PREFERENCES_FILE: preferences };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const resolve = e => resolveOverlayMainSyncMode(e, { settingsPath });
    expect(resolve(env)).toEqual({ mode: 'on', source: 'standard' });
    write(base, 'preferences.json', JSON.stringify({ overlayMainSync: { mode: 'off' } }));
    expect(resolve(env)).toEqual({ mode: 'off', source: 'platform' });
    write(base, 'settings.json', JSON.stringify({ overlayMainSync: { mode: 'shadow' } }));
    expect(resolve(env)).toEqual({ mode: 'shadow', source: 'tool' });
    for (const mode of ['on', 'off', 'shadow']) expect(resolve({ ...env, WE_DAEMON_OVERLAY_MAIN_SYNC: mode })).toEqual({ mode, source: 'env' });
    expect(log.mock.calls.flat().join('\n')).toMatch(/source=env/);
  });

  it('already synced main is skipped and off mode spawns nothing', async () => {
    const f = fixture(), spawnFn = vi.fn();
    fs.writeFileSync(sidecar(f), JSON.stringify({ lastSyncedMain: { [ref]: f.mainSha } }));
    expect(await tick(f, { spawnFn })).toMatchObject({ started: [], skipped: [ref] });
    await tick(f, { mode: 'off', spawnFn });
    expect(spawnFn).not.toHaveBeenCalled();
    expect(readOverlayState(f.root, { env: f.env }).overlays.map(o => o.ref)).toEqual([ref]);
  });
});
