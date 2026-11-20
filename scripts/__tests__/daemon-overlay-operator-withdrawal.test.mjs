import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { withdrawUnregisteredOverlay, proveOverlayWithdrawal, removeRegistration, retireRegistration, main } from '../daemon-overlay.mjs';
import { addOverlay, appendOverlayEvent, overlayFilePath, readOverlays } from '../lib/daemon-overlays.mjs';
import { matchReadyCandidate, overlayRetiredByOperator } from '../lib/daemon-rebuild/adopt.mjs';
import { createPrototypeLoader, defaultDeps } from '../operations/prototype-load-io.mjs';
import { REBUILD_IDENTITY_ENV } from '../lib/daemon-rebuild/shared.mjs';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

const roots = [];
afterEach(async () => {
  const actual = await vi.importActual('node:child_process');
  vi.mocked(spawnSync).mockReset().mockImplementation(actual.spawnSync);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'overlay-withdraw-'));
  roots.push(root);
  const env = { ...process.env, WE_DAEMON_OVERLAY_DIR: join(root, 'store'), ...REBUILD_IDENTITY_ENV };
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: root, env, encoding: 'utf8', timeout: 5000 });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('commit', '--allow-empty', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
  git('checkout', '-qb', 'lane/withdraw');
  writeFileSync(join(root, 'overlay'), 'overlay');
  git('add', 'overlay');
  git('commit', '-qm', 'overlay');
  const tip = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  git('merge', '--no-ff', '-m', 'daemon-rebuild: merge overlay lane/withdraw onto main', 'lane/withdraw');
  const args = { root, ref: 'lane/withdraw', tip, actor: 'CHALBERT', reason: 'operator withdrawal', acceptOmission: true, env,
    deps: { resolveOperatorIdentity: () => ({ login: 'chalbert', type: 'User' }) } };
  const events = () => { try { return readFileSync(overlayFilePath(root, env).replace(/\.json$/, '.events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); } catch { return []; } };
  return { root, env, git, args, tip, events };
}

describe('operator withdrawal of an unregistered live overlay', () => {
  it('withdraws an actorlessly removed auto-rebase replacement and authorizes candidate adoption', async () => {
    const root = mkdtempSync(join(tmpdir(), 'auto-rebase-withdraw-'));
    roots.push(root);
    const env = { ...process.env, WE_DAEMON_OVERLAY_DIR: join(root, 'store') };
    const ref = 'lane/fix-auto-1';
    const tip = 'a'.repeat(40);
    addOverlay(root, { ref, stackBases: ['lane/fix'] }, { env });
    // Same event shape as runAutoRebase: registration is recorded against the original ref.
    appendOverlayEvent(root, { kind: 'auto-rebase-registered', ref: 'lane/fix', new: ref,
      newSha: tip, at: '2026-01-01T00:00:00Z' }, { env });
    expect(removeRegistration({ root, ref, env, deps: { tip: () => tip } })).toMatchObject({ removed: true });
    const events = () => readFileSync(overlayFilePath(root, env).replace(/\.json$/, '.events.jsonl'), 'utf8')
      .trim().split('\n').map(JSON.parse);
    const registered = r => readOverlays(root, { env }).some(o => o.ref === r);
    expect(overlayRetiredByOperator({ ref, sha: tip, registered, events: events() })).toBe(false);
    const run = vi.fn((_cmd, args) => {
      if (args[0] === 'merge-base') return { status: 0, stdout: 'b'.repeat(40) };
      if (args[0] === 'log') return { status: 0,
        stdout: `${'b'.repeat(40)} ${tip}\t${REBUILD_IDENTITY_ENV.GIT_COMMITTER_EMAIL}\tdaemon-rebuild: merge overlay ${ref} onto main\n` };
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });
    expect(await withdrawUnregisteredOverlay({ root, ref, tip, actor: 'chalbert', reason: 'withdraw live replacement',
      acceptOmission: true, env, deps: { run, resolveOperatorIdentity: () => ({ login: 'chalbert', type: 'User' }) } }))
      .toMatchObject({ retired: true });
    const history = events();
    expect(history.some(e => e.kind === 'added' && e.ref === ref)).toBe(false);
    expect(history.at(-1)).toMatchObject({ kind: 'auto-retired', ref, tip, actor: 'chalbert',
      operatorReason: true, acceptedOmission: true });
    const nowMs = Date.now();
    const result = matchReadyCandidate({
      ready: { kind: 'candidate', prevHead: 'live', passedAt: new Date(nowMs).toISOString(),
        tree: 'candidate-tree', adopt: { finalSha: 'candidate', applied: [] } },
      plan: { finalSha: 'new-plan' }, prevHead: 'live', treeOf: () => 'plan-tree',
      stillWanted: () => true, verifyBuilt: () => true, nowMs, maxAgeMs: 3_600_000,
      liveApplied: [{ ref, sha: tip }],
      retiredByOperator: a => overlayRetiredByOperator({ ...a, registered, events: history }),
    });
    expect(result).toMatchObject({ adopt: { finalSha: 'candidate' }, retired: [ref] });
  });

  it.each([false, true])('requires acknowledgement regardless of containment in main (contained: %s)', async contained => {
    const f = fixture();
    if (contained) f.git('update-ref', 'refs/remotes/origin/main', f.tip);
    await expect(withdrawUnregisteredOverlay({ ...f.args, acceptOmission: undefined })).rejects.toThrow(/--accept-omission/);
    expect(f.events()).toEqual([]);
  });
  it('accepts the exact live tip with acknowledgement despite registered dependents', async () => {
    const f = fixture();
    addOverlay(f.root, { ref: 'lane/top', stackBases: [f.args.ref], edgeResolution: { sha: f.tip } }, { env: f.env });
    const run = vi.fn((cmd, args, opts) => {
      expect(['merge-base', 'log']).toContain(args[0]);
      expect(args).not.toContain('--is-ancestor');
      return spawnSync(cmd, args, opts);
    });
    expect(await withdrawUnregisteredOverlay({ ...f.args, deps: { ...f.args.deps, run } })).toMatchObject({ retired: true });
    expect(f.events()).toHaveLength(1);
    expect(f.events()[0]).toMatchObject({ kind: 'auto-retired', ref: f.args.ref, reason: f.args.reason,
      operatorReason: true, acceptedOmission: true, actor: 'chalbert', tip: f.tip });
    expect(readOverlays(f.root, { env: f.env }).map(o => o.ref)).toEqual(['lane/top']);
  });
  it.each(['in-main', 'pr-merged', 'pr-squash-merged', 'redundant-merge-sibling', 'superseded', 'urgent-failed', 'pr-closed'])(
    'refuses automatic reason %s as explicit withdrawal authority', async reason => {
    const f = fixture();
    await expect(withdrawUnregisteredOverlay({ ...f.args, reason })).rejects.toThrow(/operator withdrawal/);
    expect(f.events()).toEqual([]);
  });
  it.each(['--accept-omission', '--accept-uncontained'])('CLI requires explicit acknowledgement and accepts %s', async flag => {
    const f = fixture();
    vi.stubEnv('WE_DAEMON_OVERLAY_DIR', f.env.WE_DAEMON_OVERLAY_DIR);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const argv = ['retire', `--clone=${f.root}`, `--ref=${f.args.ref}`, `--tip=${f.tip}`, '--actor=chalbert', '--reason=withdraw live work'];
    const deps = { pruneStaleOverlayRecords: () => {}, ...f.args.deps };
    await expect(main(argv, deps)).rejects.toThrow(/--accept-omission/);
    expect(f.events()).toEqual([]);
    await main([...argv, flag], deps);
    expect(f.events().at(-1)).toMatchObject({ acceptedOmission: true, operatorReason: true });
  });
  it('refuses a registered ref without writing events', async () => {
    const f = fixture();
    addOverlay(f.root, { ref: f.args.ref }, { env: f.env });
    const before = f.events();
    await expect(withdrawUnregisteredOverlay(f.args)).rejects.toThrow(/registered/);
    expect(f.events()).toEqual(before);
  });
  it.each([
    ['wrong tip', { tip: 'a'.repeat(40) }, /live.*tip/],
    ['malformed ref', { ref: '../other' }, /valid --ref/],
    ['malformed tip', { tip: 'abc' }, /40-hex/],
    ['tip with trailing newline', { tip: 'a'.repeat(40) + '\n' }, /40-hex/],
    ['missing reason', { reason: ' ' }, /reason/],
    ['missing actor', { actor: undefined }, /actor/],
    ['non-operator', { actor: 'outsider', deps: { resolveOperatorIdentity: () => ({ login: 'outsider', type: 'User' }) } }, /registered operator/],
    ['bot', { deps: { resolveOperatorIdentity: () => ({ login: 'chalbert', type: 'Bot' }) } }, /human/],
    ['actor mismatch', { actor: 'outsider' }, /does not match/],
    ['unreadable identity', { deps: { resolveOperatorIdentity: () => { throw new Error('identity unreadable'); } } }, /unreadable/],
  ])('refuses %s without writing anything', async (_name, override, message) => {
    const f = fixture();
    await expect(withdrawUnregisteredOverlay({ ...f.args, ...override })).rejects.toThrow(message);
    expect(f.events()).toEqual([]);
  });
  it('refuses unreadable live history without writing anything', async () => {
    const f = fixture();
    f.git('update-ref', '-d', 'refs/remotes/origin/main');
    await expect(withdrawUnregisteredOverlay(f.args)).rejects.toThrow(/live/);
    expect(f.events()).toEqual([]);
  });
  it('refuses corrupt registration evidence without writing an event', async () => {
    const f = fixture();
    addOverlay(f.root, { ref: 'lane/other' }, { env: f.env });
    writeFileSync(overlayFilePath(f.root, f.env), '{broken');
    const before = f.events();
    await expect(withdrawUnregisteredOverlay(f.args)).rejects.toThrow(/store is corrupt/);
    expect(f.events()).toEqual(before);
  });
  it('refuses oversized history with an operator fallback and bounded subprocess IO', async () => {
    const f = fixture();
    const run = (_cmd, args, opts) => {
      expect(opts).toMatchObject({ timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
      return args[0] === 'merge-base' ? { status: 0, stdout: 'a'.repeat(40) }
        : { status: null, error: new Error('ENOBUFS'), stdout: 'partial' };
    };
    await expect(withdrawUnregisteredOverlay({ ...f.args, deps: { ...f.args.deps, run } })).rejects.toThrow(/oversized; inspect.*retrying/);
    expect(f.events()).toEqual([]);
  });
  it('refuses a merge for another ref and an unauthored merge message', async () => {
    const f = fixture();
    await expect(withdrawUnregisteredOverlay({ ...f.args, ref: 'lane/other' })).rejects.toThrow(/live applied tip/);
    const run = (cmd, args, opts) => spawnSync(cmd, args, { ...opts, env: { ...opts.env, GIT_COMMITTER_EMAIL: 'outsider@example.test' } });
    const amended = run('git', ['-c', 'commit.gpgsign=false', 'commit', '--amend', '--no-edit'], { cwd: f.root, env: f.env, encoding: 'utf8', timeout: 5000 });
    expect(amended.status).toBe(0);
    await expect(withdrawUnregisteredOverlay(f.args)).rejects.toThrow(/live applied tip/);
    expect(f.events()).toEqual([]);
  });
  it('accepts the exact live tip and repairs actorless retirement history for adoption', async () => {
    const f = fixture();
    for (const event of [
      { kind: 'added', at: '2020-01-01T00:00:00Z' },
      { kind: 'auto-retired', tip: f.tip, reason: 'old withdrawal', at: '2020-01-02T00:00:00Z' },
    ]) appendOverlayEvent(f.root, { ref: f.args.ref, ...event }, { env: f.env });
    expect(overlayRetiredByOperator({ ref: f.args.ref, sha: f.tip, registered: () => false, events: f.events() })).toBe(false);
    expect(await withdrawUnregisteredOverlay(f.args)).toMatchObject({ retired: true });
    expect(f.events().at(-1)).toMatchObject({ kind: 'auto-retired', ref: f.args.ref, tip: f.tip, actor: 'chalbert', operatorReason: true, acceptedOmission: true, reason: f.args.reason });
    expect(overlayRetiredByOperator({ ref: f.args.ref, sha: f.tip, registered: () => false, events: f.events() })).toBe(true);
  });
});

// Persist stackVia as historical registration evidence: addOverlay does not author this field.
function guardedFixture(stackVia) {
  const root = mkdtempSync(join(tmpdir(), 'overlay-stack-via-'));
  roots.push(root);
  const env = { ...process.env, WE_DAEMON_OVERLAY_DIR: join(root, 'store') };
  const ref = 'lane/base';
  const tip = 'a'.repeat(40);
  addOverlay(root, { ref }, { env });
  const entry = readOverlays(root, { env })[0];
  const registerTop = (via = stackVia) => {
    addOverlay(root, { ref: 'lane/top' }, { env });
    const file = overlayFilePath(root, env);
    const state = JSON.parse(readFileSync(file, 'utf8'));
    state.overlays.find(o => o.ref === 'lane/top').stackVia = via;
    writeFileSync(file, JSON.stringify(state));
  };
  return { root, env, ref, tip, entry, registerTop };
}

describe('guarded withdrawal stackVia protection', () => {
  it('retains a base with a concurrently registered stackVia dependent even when merge-base reports no ancestry', async () => {
    const f = guardedFixture({ 'lane/carrier': ['lane/base'] });
    let listed;
    const git = vi.fn((command, args) => {
      if (command === 'node' && args[1] === 'list') {
        listed = readOverlays(f.root, { env: f.env });
        return JSON.stringify({ list: listed });
      }
      if (command === 'git') {
        if (args[0] === 'fetch') return '';
        if (args[0] === 'rev-parse') {
          expect(existsSync(`${overlayFilePath(f.root, f.env)}.add-guard.lock`)).toBe(false);
          f.registerTop(); // after the initial listing, before guarded proof
          return f.tip;
        }
        if (args[0] === 'ls-remote') return `${f.tip}\trefs/heads/${f.ref}`;
        if (args[0] === 'merge-base') throw Object.assign(new Error('not an ancestor'), { status: 1 });
      }
      throw new Error(`unexpected subprocess: ${command} ${JSON.stringify(args)}`);
    });
    const load = createPrototypeLoader({ ...defaultDeps(), env: f.env, exec: git,
      settings: { daemons: { control: { clone: f.root } }, workspaceRoot: f.root,
        loaderCli: 'scripts/daemon-overlay.mjs', recordPath: join(f.root, 'loads.jsonl') } });
    expect(await load({ daemon: 'control', remove: f.ref, reason: 'withdraw base' }))
      .toMatchObject({ ok: false, stopReason: 'remove-refused', detail: 'not-proved', removed: [] });
    expect(listed).toEqual([f.entry]);
    expect(readOverlays(f.root, { env: f.env })).toEqual([f.entry,
      expect.objectContaining({ ref: 'lane/top', stackVia: { 'lane/carrier': [f.ref] } })]);
    expect(git.mock.calls.some(([command, args]) => command === 'git' && args[0] === 'merge-base')).toBe(false);
  });

  it('urgent withdrawal retains a stackVia base under the add guard before invoking retirement proof', async () => {
    const f = guardedFixture({ 'lane/carrier': ['lane/base'] });
    const registration = { clone: f.root, ref: f.ref, sha: f.tip };
    const git = vi.mocked(spawnSync).mockImplementation((command, args) => {
      expect(command).toBe('git');
      if (args[0] === 'ls-remote') return { status: 0, stdout: `${f.tip}\trefs/heads/${f.ref}` };
      if (args[0] === 'fetch') return { status: 0, stdout: '' };
      if (args[0] === 'rev-parse') return { status: 0, stdout: 'b'.repeat(40) };
      if (args[0] === 'merge-base') return { status: 1, stdout: '' };
      throw new Error(`unexpected git command: ${JSON.stringify(args)}`);
    });
    const prove = vi.fn(() => ({ action: 'retire', tip: f.tip, reason: 'urgent-failed' }));
    expect(await retireRegistration({ root: f.root, ref: f.ref, expectedTip: f.tip, expectedEntry: f.entry,
      mode: 'urgent-failed', trackingId: 'attempt', env: f.env, deps: {
        prove, tip: () => f.tip,
        readUrgentLoads: () => {
          expect(existsSync(`${overlayFilePath(f.root, f.env)}.add-guard.lock`)).toBe(true);
          f.registerTop();
          return [{ type: 'prototype-load.urgent', trackingId: 'attempt', clone: f.root,
            ref: f.ref, sha: f.tip, registration, at: '2026-01-01T00:00:00Z' }];
        },
        readUrgentDecisions: () => [{ status: 'unload-decision', trackingId: 'attempt', clone: f.root,
          ref: f.ref, sha: f.tip, registration, at: '2026-01-02T00:00:00Z', reason: 'ci-failed',
          check: { head_sha: f.tip, status: 'completed', conclusion: 'failure' } }],
      } })).toMatchObject({ retired: false, refused: 'stacked-or-unreadable' });
    expect(git).not.toHaveBeenCalled();
    expect(prove).not.toHaveBeenCalled();
    expect(readOverlays(f.root, { env: f.env }).find(o => o.ref === f.ref)).toEqual(f.entry);
  });

  it.each([null, false, [], 'lane/base', { carrier: 'lane/base' }, { carrier: [null] }, { carrier: ['../base'] }])(
    'refuses malformed stackVia evidence %j before any Git proof', stackVia => {
      const f = guardedFixture(stackVia);
      f.registerTop();
      const before = readOverlays(f.root, { env: f.env });
      const git = vi.fn(() => ({ code: 1, stdout: '' }));
      expect(proveOverlayWithdrawal({ root: f.root, ref: f.ref, tip: f.tip, reason: 'withdraw', env: f.env, git }))
        .toEqual({ action: 'keep', reason: 'unreadable-stack-evidence' });
      expect(git).not.toHaveBeenCalled();
      expect(readOverlays(f.root, { env: f.env })).toEqual(before);
    });
});
