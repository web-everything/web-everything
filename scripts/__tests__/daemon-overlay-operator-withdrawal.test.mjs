import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { withdrawUnregisteredOverlay, withdrawRegisteredOverlay, main, replaceRegistration } from '../daemon-overlay.mjs';
import { addOverlay, appendOverlayEvent, overlayFilePath, readOverlays } from '../lib/daemon-overlays.mjs';
import { overlayRetiredByOperator } from '../lib/daemon-rebuild/adopt.mjs';
import { REBUILD_IDENTITY_ENV } from '../lib/daemon-rebuild/shared.mjs';
import { AUTOMATIC_RETIREMENT_REASONS } from '../operations/prototype-retire.mjs';

const roots = [];
afterEach(() => {
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
    expect(f.events().at(-1)).toMatchObject({ operatorReason: true, acceptedOmission: true, actor: 'chalbert', tip: f.tip });
    expect(readOverlays(f.root, { env: f.env }).map(o => o.ref)).toEqual(['lane/top']);
  });
  it('refuses automatic reasons as explicit withdrawal authority', async () => {
    const f = fixture();
    await expect(withdrawUnregisteredOverlay({ ...f.args, reason: 'in-main' })).rejects.toThrow(/operator withdrawal/);
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
  describe.each(['remove', 'retire'])('ordinary %s CLI', cmd => {
    async function run(f, actor, identity, reason = f.args.reason) {
      vi.stubEnv('WE_DAEMON_OVERLAY_DIR', f.env.WE_DAEMON_OVERLAY_DIR);
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      return main([cmd, `--clone=${f.root}`, `--ref=${f.args.ref}`, '--json',
        `--reason=${reason}`, ...(cmd === 'retire' ? [`--expected-tip=${f.tip}`] : []),
        ...(actor === undefined ? [] : [`--actor=${actor}`])], {
        pruneStaleOverlayRecords: () => {}, resolveOperatorIdentity: identity,
        tip: () => f.tip, prove: () => ({ action: 'retire', reason: 'in-main', tip: f.tip }),
      });
    }
    it('records the authenticated lowercase actor only with explicit --actor', async () => {
      const f = fixture();
      addOverlay(f.root, { ref: f.args.ref }, { env: f.env });
      const identity = vi.fn(() => ({ login: 'CHALBERT', type: 'User' }));
      await run(f, 'CHALBERT', identity);
      expect(identity).toHaveBeenCalledTimes(1);
      expect(f.events().at(-1)).toMatchObject({ kind: cmd === 'remove' ? 'removed' : 'auto-retired', actor: 'chalbert' });
      if (cmd === 'remove') expect(f.events().at(-1)).toHaveProperty('operatorReason', true);
      else expect(f.events().at(-1)).not.toHaveProperty('operatorReason');
    });
    it('without --actor removes without resolving identity or supplying operator proof', async () => {
      const f = fixture();
      addOverlay(f.root, { ref: f.args.ref }, { env: f.env });
      const identity = vi.fn(() => { throw new Error('must not resolve absent actor'); });
      await run(f, undefined, identity);
      expect(identity).not.toHaveBeenCalled();
      expect(f.events().at(-1)).toMatchObject({ kind: cmd === 'remove' ? 'removed' : 'auto-retired' });
      expect(f.events().at(-1)).not.toHaveProperty('actor');
      expect(f.events().at(-1)).not.toHaveProperty('operatorReason');
    });
    it.each(['', ' ', ...AUTOMATIC_RETIREMENT_REASONS.map(reason => ` ${reason.toUpperCase()} `)])(
      'authenticated actor with empty or automatic reason %j supplies no withdrawal authority', async reason => {
        const f = fixture();
        addOverlay(f.root, { ref: f.args.ref }, { env: f.env });
        await run(f, 'CHALBERT', () => ({ login: 'CHALBERT', type: 'User' }), reason);
        expect(f.events().at(-1)).toMatchObject({ kind: cmd === 'remove' ? 'removed' : 'auto-retired', actor: 'chalbert' });
        expect(f.events().at(-1)).not.toHaveProperty('operatorReason');
      },
    );
    it('refuses a non-operator --actor before removing or writing an event', async () => {
      const f = fixture();
      addOverlay(f.root, { ref: f.args.ref }, { env: f.env });
      const before = readFileSync(overlayFilePath(f.root, f.env), 'utf8');
      const events = f.events();
      await expect(run(f, 'outsider', () => ({ login: 'outsider', type: 'User' }))).rejects.toThrow(/registered operator/);
      expect(readFileSync(overlayFilePath(f.root, f.env), 'utf8')).toBe(before);
      expect(f.events()).toEqual(events);
    });
  });
  it('records authenticated attribution for replace', async () => {
    const f = fixture();
    addOverlay(f.root, { ref: f.args.ref }, { env: f.env });
    const result = await replaceRegistration({ ...f.args, actor: undefined, old: f.args.ref, ref: 'lane/new', expectedSha: f.tip,
      deps: { ...f.args.deps, tip: () => f.tip,
        contain: () => ({ ok: true, contained: true, oldTip: f.tip, newTip: f.tip }),
        check: () => ({ ok: true, clean: true, candSha: f.tip }) } });
    expect(result).toMatchObject({ ok: true, replaced: true });
    expect(f.events().at(-1)).toMatchObject({ kind: 'replaced', actor: 'chalbert' });
  });
});


describe('registered explicit withdrawal acknowledgement and tip guards', () => {
  function registeredFixture() {
    const f = fixture();
    addOverlay(f.root, { ref: f.args.ref }, { env: f.env });
    const options = { root: f.root, env: f.env, ref: f.args.ref, expectedTip: f.tip,
      reason: 'withdraw live fix', actor: 'chalbert', acceptOmission: true, deps: { tip: () => f.tip } };
    return { ...f, options };
  }
  it.each([undefined, false, 'true'])('refuses missing or non-boolean acknowledgement (%s) without mutation', async acceptOmission => {
    const f = registeredFixture();
    await expect(async () => withdrawRegisteredOverlay({ ...f.options, acceptOmission })).rejects.toThrow(/--accept-omission/);
    expect(readOverlays(f.root, { env: f.env })).toHaveLength(1);
    expect(f.events()).toEqual([]);
  });
  it.each(['acceptOmission', 'acceptUncontained'])('accepts %s with an exact tip and records acknowledgement and actor', async flag => {
    const f = registeredFixture();
    expect(await withdrawRegisteredOverlay({ ...f.options, acceptOmission: false, [flag]: true })).toMatchObject({ retired: true });
    expect(f.events().at(-1)).toMatchObject({ kind: 'auto-retired', ref: f.args.ref, tip: f.tip,
      operatorReason: true, acceptedOmission: true, actor: 'chalbert', reason: 'withdraw live fix' });
  });
  it.each([' ', 'in-main'])('refuses empty or automatic reason %j', async reason => {
    const f = registeredFixture();
    await expect(async () => withdrawRegisteredOverlay({ ...f.options, reason })).rejects.toThrow(/reason required/);
    expect(f.events()).toEqual([]);
    expect(readOverlays(f.root, { env: f.env })).toHaveLength(1);
  });
  it('refuses an inexact tip before removal', async () => {
    const f = registeredFixture();
    expect(await withdrawRegisteredOverlay({ ...f.options, expectedTip: 'a'.repeat(40) })).toMatchObject({ retired: false, refused: 'tip-moved' });
    expect(f.events()).toEqual([]);
    expect(readOverlays(f.root, { env: f.env })).toHaveLength(1);
  });
  it('restores the registration if the tip moves after removal without granting operator authority', async () => {
    const f = registeredFixture();
    let moved = false;
    expect(await withdrawRegisteredOverlay({ ...f.options, deps: {
      tip: () => moved ? 'a'.repeat(40) : f.tip, afterDrop: () => { moved = true; },
    } })).toMatchObject({ retired: false, refused: 'tip-moved-restored' });
    expect(readOverlays(f.root, { env: f.env })).toHaveLength(1);
    expect(f.events().at(-1)).toMatchObject({ kind: 'auto-retire-reverted' });
    expect(f.events().at(-1)).not.toHaveProperty('operatorReason');
  });
});
