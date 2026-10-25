import { describe, it, expect, vi } from 'vitest';
import { laneHeadCheck, ensureLaneHead, probeLaneHead, runFixCli, LauncherError, parseAcquiredLanePath } from '../fix-run.mjs';

const holder = 'conveyor-fix-lane-10-eaae3ffe';
const foreign = 'orchestrator-slots-lane-10-4fef772b';
const prHead = '6509e66bc'.padEnd(40, '0');
const oldHead = '9904fc5'.padEnd(40, '0');
const lease = { holder };

function fixture({ head = prHead, owner = holder } = {}) {
  const state = { head, owner, dirty: '', spawnHead: null };
  const calls = [];
  const run = vi.fn((cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === 'gh') return JSON.stringify({ title: 'T', headRefOid: prHead });
    if (args.includes('acquire')) {
      if (args.includes('--lane=10')) state.head = prHead;
      return JSON.stringify({ path: '/lanes/lane-10', holder });
    }
    if (args.includes('rev-parse') && args.at(-1) === 'HEAD') return state.head;
    if (args.includes('status')) return state.dirty;
    return '';
  });
  const readLease = vi.fn(() => ({ holder: state.owner }));
  const spawn = vi.fn(async () => { state.spawnHead = state.head; });
  const recordOutcome = vi.fn(), appendLoopRow = vi.fn(), releaseClaim = vi.fn(async () => ({}));
  const io = { run, readLease, readPrompt: () => 'brief', removePrompt: () => {},
    readComments: async () => [{ body: '🔁 review — changes requested\nrepair' }],
    resolveProvider: () => ({ spawn }), pendingRearm: { read: () => null, write: () => {}, clear: () => {} },
    recordOutcome, recordRouted: () => ({}), appendLoopRow, releaseClaim,
    recordPush: () => {}, write: () => {}, writeErr: () => {}, weRoot: '/we' };
  return { state, calls, run, readLease, spawn, recordOutcome, appendLoopRow, releaseClaim, io };
}
const argv = ['--pr=5759', '--session=fix-5759', '--ref=lane/pr', '--prompt-file=/p', '--provider=codex'];

describe('fixer lane head guard', () => {
  it('accepts both legacy path output and JSON acquire output', () => {
    expect(parseAcquiredLanePath('noise\n/lanes/lane-10\n')).toBe('/lanes/lane-10');
    expect(parseAcquiredLanePath(JSON.stringify({ path: '/lanes/lane-10', holder }))).toBe('/lanes/lane-10');
  });
  it('accepts the PR head only with our holder', () => {
    expect(laneHeadCheck({ laneHead: prHead, prHead, lease, holder })).toMatchObject({ ok: true, action: 'ok' });
    expect(laneHeadCheck({ laneHead: oldHead, prHead, lease, holder, clean: true })).toMatchObject({ ok: false, action: 'reset' });
    expect(laneHeadCheck({ laneHead: prHead, prHead, lease: null, holder })).toMatchObject({ action: 'refuse' });
  });
  it('recovers through lane-pool acquire with our holder, then re-checks before spawning', async () => {
    const f = fixture({ head: oldHead });
    expect((await runFixCli(argv, f.io)).code).toBe(0);
    expect(f.state.spawnHead).toBe(prHead);
    const recovery = f.calls.find(c => c.args.includes('--lane=10') && c.args.includes('acquire'));
    expect(recovery.cmd).toBe('node');
    expect(recovery.args).toEqual(['/we/scripts/lane-pool.mjs', 'acquire', '--lane=10',
      '--session=fix-5759', `--expect-holder=${holder}`, '--purpose=conveyor-fix', '--base=lane/pr']);
    expect(recovery.opts).toMatchObject({ cwd: '/we', env: { LANE_SESSION: holder } });
    expect(f.readLease.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(f.calls.some(c => c.args.includes('reset') || c.args.includes('fetch'))).toBe(false);
    expect(f.calls.filter(c => c.args.includes('rev-parse')).length).toBeGreaterThanOrEqual(4);
  });
  it('refuses recovery with an empty holder without calling acquire', () => {
    const f = fixture({ head: oldHead });
    expect(() => ensureLaneHead({ lanePath: '/lanes/lane-10', prHead, holder: '',
      sessionSlug: 'fix-5759', ref: 'lane/pr', weRoot: '/we', run: f.run, readLease: f.readLease }))
      .toThrow(LauncherError);
    expect(f.calls.some(c => c.args.includes('acquire'))).toBe(false);
  });
  it('refuses a foreign lease before spawn and records infra failure, releasing the claim', async () => {
    const f = fixture({ head: oldHead, owner: foreign });
    expect((await runFixCli(argv, f.io)).code).toBe(1);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.calls.filter(c => c.args.includes('acquire'))).toHaveLength(1);
    expect(f.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', reason: expect.stringContaining(foreign) }));
    expect(f.appendLoopRow).toHaveBeenCalledWith(expect.objectContaining({ infra: true }));
    expect(f.releaseClaim).toHaveBeenCalledOnce();
  });
  it('refuses push when the agent loses its lease', async () => {
    const f = fixture();
    f.spawn.mockImplementation(async () => { f.state.head = 'a'.repeat(40); });
    f.io.pendingRearm.write = () => { f.state.owner = foreign; };
    expect((await runFixCli(argv, f.io)).code).toBe(1);
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.calls.some(c => c.args.includes('push'))).toBe(false);
    expect(f.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringContaining('refusing to push') }));
  });
  it.each(['dirty', 'unpushed', 'foreign-at-acquire', 'wrong-head-after-acquire', 'stolen-after-acquire'])('refuses unsafe recovery before spawning: %s', async kind => {
    const f = fixture({ head: oldHead });
    if (kind === 'dirty') f.state.dirty = ' M file';
    const run = (cmd, args, opts) => {
      if (args.includes('acquire') && args.includes('--lane=10')) {
        if (kind === 'foreign-at-acquire') f.state.owner = foreign;
        if (kind === 'unpushed' || kind === 'foreign-at-acquire') {
          throw new Error(kind === 'unpushed' ? 'lane has unpushed local commits' : 'foreign lease');
        }
        const value = f.run(cmd, args, opts);
        if (kind === 'wrong-head-after-acquire') f.state.head = oldHead;
        if (kind === 'stolen-after-acquire') f.state.owner = foreign;
        return value;
      }
      return f.run(cmd, args, opts);
    };
    expect((await runFixCli(argv, { ...f.io, run })).code).toBe(1);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.state.head).toBe(kind === 'stolen-after-acquire' ? prHead : oldHead);
    expect(f.calls.some(c => c.args.includes('reset') || c.args.includes('fetch'))).toBe(false);
    expect(f.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed' }));
  });
  it('wraps allocator containment refusal as LauncherError', () => {
    const f = fixture({ head: oldHead });
    const run = (cmd, args, opts) => {
      if (args.includes('acquire')) throw new Error('unpushed local commits');
      return f.run(cmd, args, opts);
    };
    expect(() => ensureLaneHead({ lanePath: '/lanes/lane-10', prHead, holder,
      sessionSlug: 'fix-5759', ref: 'lane/pr', weRoot: '/we', run, readLease: f.readLease })).toThrow(LauncherError);
  });
  it('rechecks the lease immediately before spawn after launcher preparation', async () => {
    const f = fixture();
    f.io.resolveProvider = () => { f.state.owner = foreign; return { spawn: f.spawn }; };
    expect((await runFixCli(argv, f.io)).code).toBe(1);
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it('recovers a second clean HEAD drift before spawn', async () => {
    const f = fixture();
    f.io.resolveProvider = () => { f.state.head = oldHead; return { spawn: f.spawn }; };
    expect((await runFixCli(argv, f.io)).code).toBe(0);
    expect(f.state.spawnHead).toBe(prHead);
  });
  it('never resets launcher merge preparation on a mismatch', () => {
    const f = fixture({ head: oldHead });
    expect(() => ensureLaneHead({ lanePath: '/lanes/lane-10', prHead, holder,
      run: f.run, readLease: f.readLease, allowReset: false })).toThrow(LauncherError);
    expect(f.calls.some(c => c.args.includes('fetch') || c.args.includes('reset'))).toBe(false);
  });
  it('probe reads live evidence without writes and requires an asserted holder', () => {
    const f = fixture({ head: oldHead });
    const result = probeLaneHead({ lanePath: '/lanes/lane-10', pr: 5759, holder, run: f.run, readLease: f.readLease });
    expect(result).toMatchObject({ laneHead: oldHead, prHead, action: 'reset' });
    expect(probeLaneHead({ lanePath: '/lanes/lane-10', pr: 5759, run: f.run, readLease: f.readLease }).action).toBe('refuse');
    expect(f.calls.every(c => c.cmd === 'gh' || c.args.includes('rev-parse') || c.args.includes('status') || c.args.includes('config'))).toBe(true);
    expect(f.calls.filter(c => c.cmd === 'git').every(c => c.opts.env.GIT_OPTIONAL_LOCKS === '0')).toBe(true);
  });
});
