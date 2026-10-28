import { describe, it, expect, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { assertLaneLease, runFixCli } from '../fix-run.mjs';

const holder = 'conveyor-fix-lane-10-eaae3ffe';
const foreign = 'orchestrator-slots-lane-10-4fef772b';
const prHead = '6509e66bc'.padEnd(40, '0');

function fixture({ head = prHead, owner = holder, lanePath = '/lanes/lane-10' } = {}) {
  const state = { head, owner, dirty: '', spawnHead: null };
  const calls = [];
  const run = vi.fn((cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === 'gh') return JSON.stringify({ title: 'T', headRefOid: prHead });
    if (args.includes('acquire')) {
      if (args.includes('--lane=10')) state.head = prHead;
      return JSON.stringify({ path: lanePath, holder });
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
  const renewLease = vi.fn();
  Object.assign(io, { renewLease, heartbeatMs: 10 });
  return { state, calls, run, readLease, spawn, recordOutcome, appendLoopRow, releaseClaim, io,
    renewLease, lanePath };
}
const argv = ['--pr=5759', '--session=fix-5759', '--ref=lane/pr', '--prompt-file=/p', '--provider=codex'];

describe('fix-run lane lease heartbeat', () => {
  it('renews our lease at least twice while spawn is pending and stops after returning', async () => {
    const f = fixture();
    let pendingRenewals;
    f.spawn.mockImplementation(async () => {
      await delay(60);
      pendingRenewals = f.renewLease.mock.calls.slice();
    });
    const result = await runFixCli(argv, f.io);
    const countAtReturn = f.renewLease.mock.calls.length;
    await delay(50);
    expect.soft(result.code).toBe(0);
    expect.soft(pendingRenewals.length).toBeGreaterThanOrEqual(2);
    for (const args of pendingRenewals) {
      expect.soft(args).toEqual([{ lanePath: f.lanePath, holder }]);
    }
    expect(f.renewLease).toHaveBeenCalledTimes(countAtReturn);
  });

  it('never renews a lease held by a foreign holder during the agent run', async () => {
    const f = fixture();
    f.spawn.mockImplementation(async () => {
      f.state.owner = foreign;
      await delay(60);
    });
    await runFixCli(argv, f.io);
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.renewLease).not.toHaveBeenCalled();
  });
});

describe('fix-run lease loss after the agent', () => {
  it.each(['missing', 'foreign'])('records a %s lease as lease-lost without pushing', async kind => {
    const f = fixture();
    let callsAfterSpawn;
    f.spawn.mockImplementation(async () => {
      callsAfterSpawn = f.calls.length;
      f.readLease.mockReturnValue(kind === 'missing' ? null : { holder: foreign });
    });
    const result = await runFixCli(argv, f.io);
    expect.soft(result.code).toBe(1);
    expect(f.spawn).toHaveBeenCalledOnce();
    expect.soft(f.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'lease-lost', reason: expect.stringMatching(/lease/i),
    }));
    expect.soft(f.appendLoopRow).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'lease-lost', infra: false, reason: expect.stringMatching(/lease/i),
    }));
    expect.soft(f.calls.some(c => c.args.includes('push'))).toBe(false);
    if (kind === 'foreign') {
      expect.soft(f.calls.slice(callsAfterSpawn).some(c =>
        c.args.some(arg => arg.endsWith('lane-pool.mjs'))
        && (c.args.includes('release') || c.args.includes('acquire')))).toBe(false);
      expect(f.renewLease).not.toHaveBeenCalled();
    }
  });
});

describe('assertLaneLease ownership guard', () => {
  it.each([
    ['missing', null],
    ['foreign', { holder: foreign }],
  ])('still throws the ordinary holder mismatch for a %s lease', (_kind, lease) => {
    expect(() => assertLaneLease({
      lanePath: '/lanes/lane-10', holder, readLease: () => lease,
    })).toThrow(/lease now held by/);
  });
});
