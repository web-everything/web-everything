import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { withdrawUnregisteredOverlay, main, replaceRegistration } from '../daemon-overlay.mjs';
import { addOverlay, appendOverlayEvent, overlayFilePath } from '../lib/daemon-overlays.mjs';
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
  const args = { root, ref: 'lane/withdraw', tip, actor: 'CHALBERT', reason: 'operator withdrawal', acceptUncontained: true, env,
    deps: { resolveOperatorIdentity: () => ({ login: 'chalbert', type: 'User' }) } };
  const events = () => { try { return readFileSync(overlayFilePath(root, env).replace(/\.json$/, '.events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); } catch { return []; } };
  return { root, env, git, args, tip, events };
}

describe('operator withdrawal of an unregistered live overlay', () => {
  it.each(['stackBases', 'stackVia', 'ancestry'])('refuses a registered stacked dependent via %s even with acceptance', async (via) => {
    const f = fixture();
    addOverlay(f.root, { ref: 'lane/top', ...(via === 'stackBases' ? { stackBases: [f.args.ref] } : {}) }, { env: f.env });
    if (via === 'stackVia') {
      const store = JSON.parse(readFileSync(overlayFilePath(f.root, f.env), 'utf8'));
      store.overlays[0].stackVia = { pr: [f.args.ref] };
      writeFileSync(overlayFilePath(f.root, f.env), JSON.stringify(store));
    }
    f.git('update-ref', 'refs/remotes/origin/lane/top', f.tip);
    const before = f.events();
    await expect(withdrawUnregisteredOverlay(f.args)).rejects.toThrow(/stacked/);
    expect(f.events()).toEqual(before);
  });
  it.each([{ stackBases: 'unknown' }, { stackVia: { ancestry: null } }])('refuses malformed stored stack evidence %j', async fields => {
    const f = fixture();
    addOverlay(f.root, { ref: 'lane/other' }, { env: f.env });
    const store = JSON.parse(readFileSync(overlayFilePath(f.root, f.env), 'utf8'));
    Object.assign(store.overlays[0], fields);
    writeFileSync(overlayFilePath(f.root, f.env), JSON.stringify(store));
    const before = f.events();
    await expect(withdrawUnregisteredOverlay(f.args)).rejects.toThrow(/unreadable-stack-evidence/);
    expect(f.events()).toEqual(before);
  });
  it('refuses uncontained content without explicit acceptance', async () => {
    const f = fixture();
    await expect(withdrawUnregisteredOverlay({ ...f.args, acceptUncontained: undefined })).rejects.toThrow(/--accept-uncontained/);
    expect(f.events()).toEqual([]);
  });
  it('accepts uncontained content with explicit acceptance and records it', async () => {
    const f = fixture();
    expect(await withdrawUnregisteredOverlay(f.args)).toMatchObject({ retired: true });
    expect(f.events().at(-1)).toMatchObject({ operatorReason: true, acceptUncontained: true });
  });
  it('accepts contained content without acceptance override', async () => {
    const f = fixture();
    f.git('update-ref', 'refs/remotes/origin/main', f.tip);
    expect(await withdrawUnregisteredOverlay({ ...f.args, acceptUncontained: undefined })).toMatchObject({ retired: true });
    expect(f.events().at(-1)).not.toHaveProperty('acceptUncontained');
  });
  it('refuses an unresolvable dependent tip with a fetch-first fallback', async () => {
    const f = fixture();
    addOverlay(f.root, { ref: 'lane/missing' }, { env: f.env });
    const before = f.events();
    await expect(withdrawUnregisteredOverlay(f.args)).rejects.toThrow(
      "cannot prove no registered overlay depends on lane/withdraw; fetch the clone's overlays first");
    expect(f.events()).toEqual(before);
  });
  it('refuses a stale tracking ref with no cached relationship and truncated local history', async () => {
    const f = fixture();
    addOverlay(f.root, { ref: 'lane/top' }, { env: f.env });
    const stale = f.git('commit-tree', 'HEAD^{tree}', '-p', 'refs/remotes/origin/main', '-m', 'old top');
    f.git('update-ref', 'refs/remotes/origin/lane/top', stale);
    // The remote may have advanced to depend on the withdrawn tip. Locally the stale
    // tip's history is truncated: --is-ancestor returns 1 without proving independence.
    writeFileSync(join(f.root, '.git', 'shallow'), `${stale}\n`);
    const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', f.tip, stale], { cwd: f.root, encoding: 'utf8' });
    expect(ancestry.status).toBe(1);
    const before = f.events();
    const run = vi.fn((cmd, args, opts) => {
      if (['fetch', 'ls-remote'].includes(args[0])) throw new Error('withdrawal must be fetch-free');
      return spawnSync(cmd, args, opts);
    });
    await expect(withdrawUnregisteredOverlay({ ...f.args, deps: { ...f.args.deps, run } })).rejects.toThrow(
      "cannot prove no registered overlay depends on lane/withdraw; fetch the clone's overlays first");
    expect(f.events()).toEqual(before);
  });
  it.each(['merge-base', 'ancestry'])('refuses unreadable local %s evidence for a resolvable overlay', async stage => {
    const f = fixture();
    addOverlay(f.root, { ref: 'lane/other' }, { env: f.env });
    const otherTip = f.git('rev-parse', 'refs/remotes/origin/main');
    f.git('update-ref', 'refs/remotes/origin/lane/other', otherTip);
    const run = (cmd, args, opts) => {
      if (args[0] === 'merge-base' && args.at(-1) === otherTip
        && (args[1] === '--is-ancestor') === (stage === 'ancestry')) return { status: 128, stdout: '' };
      return spawnSync(cmd, args, opts);
    };
    await expect(withdrawUnregisteredOverlay({ ...f.args, deps: { ...f.args.deps, run } })).rejects.toThrow(
      "cannot prove no registered overlay depends on lane/withdraw; fetch the clone's overlays first");
    expect(f.events()).toEqual([]);
  });
  it('refuses unreadable containment even with explicit acceptance', async () => {
    const f = fixture();
    const run = (cmd, args, opts) => args[0] === 'merge-base' && args[1] === '--is-ancestor'
      ? { status: 128, stdout: '' } : spawnSync(cmd, args, opts);
    await expect(withdrawUnregisteredOverlay({ ...f.args, deps: { ...f.args.deps, run } })).rejects.toThrow(/containment unreadable/);
    expect(f.events()).toEqual([]);
  });
  it('accepts resolvable independent registered overlays using only local evidence', async () => {
    const f = fixture();
    addOverlay(f.root, { ref: 'lane/independent' }, { env: f.env });
    f.git('update-ref', 'refs/remotes/origin/lane/independent', f.git('rev-parse', 'refs/remotes/origin/main'));
    addOverlay(f.root, { ref: 'lane/second' }, { env: f.env });
    const secondTip = f.git('commit-tree', 'HEAD^{tree}', '-p', 'refs/remotes/origin/main', '-m', 'independent');
    f.git('update-ref', 'refs/remotes/origin/lane/second', secondTip);
    const run = vi.fn((cmd, args, opts) => {
      if (['fetch', 'ls-remote'].includes(args[0])) throw new Error('withdrawal must be fetch-free');
      return spawnSync(cmd, args, opts);
    });
    expect(await withdrawUnregisteredOverlay({ ...f.args, deps: { ...f.args.deps, run } })).toMatchObject({ retired: true });
    expect(run).toHaveBeenCalled();
  });
  it('refuses automatic reasons as explicit withdrawal authority', async () => {
    const f = fixture();
    await expect(withdrawUnregisteredOverlay({ ...f.args, reason: 'in-main' })).rejects.toThrow(/operator withdrawal/);
    expect(f.events()).toEqual([]);
  });
  it('CLI requires --accept-uncontained and records explicit acceptance', async () => {
    const f = fixture();
    vi.stubEnv('WE_DAEMON_OVERLAY_DIR', f.env.WE_DAEMON_OVERLAY_DIR);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const argv = ['retire', `--clone=${f.root}`, `--ref=${f.args.ref}`, `--tip=${f.tip}`, '--actor=chalbert', '--reason=withdraw live work'];
    const deps = { pruneStaleOverlayRecords: () => {}, ...f.args.deps };
    await expect(main(argv, deps)).rejects.toThrow(/--accept-uncontained/);
    expect(f.events()).toEqual([]);
    await main([...argv, '--accept-uncontained'], deps);
    expect(f.events().at(-1)).toMatchObject({ acceptUncontained: true, operatorReason: true });
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
    expect(f.events().at(-1)).toMatchObject({ kind: 'auto-retired', ref: f.args.ref, tip: f.tip, actor: 'chalbert', operatorReason: true, reason: f.args.reason });
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
