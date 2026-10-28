import { describe, it, expect, vi, onTestFinished } from 'vitest';
import { existsSync, ftruncateSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assertLaneLease, defaultRenewLease, readLaneLease, runFixCli } from '../fix-run.mjs';

vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal();
  return { ...fs, ftruncateSync: vi.fn(fs.ftruncateSync) };
});

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

function diskLeaseFixture() {
  const lanePath = mkdtempSync(join(tmpdir(), 'fix-renew-lease-'));
  onTestFinished(() => rmSync(lanePath, { recursive: true, force: true }));
  const gitDir = join(lanePath, '.git');
  mkdirSync(gitDir);
  return { lanePath, gitDir, file: join(gitDir, '.lane-lease') };
}

describe('defaultRenewLease on disk', () => {
  it('renews an owned lease in place, setting renewedAt and keeping the holder', () => {
    const { lanePath, file } = diskLeaseFixture();
    const lease = { holder, acquiredAt: '2026-01-01T00:00:00.000Z' };
    writeFileSync(file, JSON.stringify(lease) + ' '.repeat(512));
    const before = statSync(file);

    expect(defaultRenewLease({ lanePath, holder })).toBe(true);

    const contents = readFileSync(file, 'utf8');
    const renewed = JSON.parse(contents);
    expect(renewed).toEqual({ ...lease, renewedAt: expect.any(String) });
    expect(new Date(renewed.renewedAt).toISOString()).toBe(renewed.renewedAt);
    expect(contents).toBe(`${JSON.stringify(renewed, null, 2)}\n`);
    const after = statSync(file);
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
  });

  it('returns false for a missing lease without creating a file', () => {
    const { lanePath, gitDir, file } = diskLeaseFixture();

    expect(defaultRenewLease({ lanePath, holder })).toBe(false);

    expect(existsSync(file)).toBe(false);
    expect(readdirSync(gitDir)).toEqual([]);
  });

  it('returns false and leaves a foreign lease byte-identical', () => {
    const { lanePath, file } = diskLeaseFixture();
    const contents = Buffer.from(`{ "holder": "${foreign}", "renewedAt": "2026-01-01T00:00:00.000Z" }\n`);
    writeFileSync(file, contents);

    expect(defaultRenewLease({ lanePath, holder })).toBe(false);

    expect(readFileSync(file)).toEqual(contents);
  });

  it('fails closed when an ownership check reads the lease during renewal', async () => {
    const { lanePath, file } = diskLeaseFixture();
    writeFileSync(file, JSON.stringify({ holder }));
    const fs = await vi.importActual('node:fs');
    let readError, ownershipError;
    vi.mocked(ftruncateSync).mockImplementationOnce((fd, length) => {
      fs.ftruncateSync(fd, length);
      try { readLaneLease(lanePath); } catch (e) { readError = e; }
      try { assertLaneLease({ lanePath, holder }); } catch (e) { ownershipError = e; }
    });

    expect(defaultRenewLease({ lanePath, holder })).toBe(true);

    // Truncate + write deliberately trades atomic reader visibility for successor safety.
    expect(readError).toBeInstanceOf(SyntaxError);
    expect(ownershipError).toBeInstanceOf(Error);
    expect(readLaneLease(lanePath)).toEqual({ holder, renewedAt: expect.any(String) });
    expect(() => assertLaneLease({ lanePath, holder })).not.toThrow();
  });

  it.each(['deleted', 'replaced'])('never recreates or overwrites a lease %s during renewal', async kind => {
    const { lanePath, gitDir, file } = diskLeaseFixture();
    writeFileSync(file, JSON.stringify({ holder }));
    const contents = Buffer.from(`{ "holder": "${foreign}" }\n`);
    const successor = join(gitDir, 'successor');
    if (kind === 'replaced') writeFileSync(successor, contents);
    const fs = await vi.importActual('node:fs');
    let observedDuringRenewal;
    vi.mocked(ftruncateSync).mockImplementationOnce((fd, length) => {
      if (kind === 'deleted') rmSync(file);
      else renameSync(successor, file);
      fs.ftruncateSync(fd, length);
      observedDuringRenewal = readLaneLease(lanePath);
    });

    expect(defaultRenewLease({ lanePath, holder })).toBe(true);

    if (kind === 'deleted') {
      expect(observedDuringRenewal).toBeNull();
      expect(existsSync(file)).toBe(false);
      expect(readdirSync(gitDir)).toEqual([]);
    } else {
      expect(observedDuringRenewal).toEqual({ holder: foreign });
      expect(readFileSync(file)).toEqual(contents);
    }
  });
});

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
      outcome: 'failed', infra: false, reason: expect.stringMatching(/^lease-lost:/),
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
