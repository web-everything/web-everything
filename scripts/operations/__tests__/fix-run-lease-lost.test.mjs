import { describe, it, expect, vi, onTestFinished } from 'vitest';
import { existsSync, ftruncateSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assertLaneLease, defaultRenewLease, readLaneLease, runFixCli } from '../fix-run.mjs';
import { classifyFixRunOutcome } from '../../conveyor/fix-loop-ledger.mjs';

vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal();
  return { ...fs, ftruncateSync: vi.fn(fs.ftruncateSync), writeSync: vi.fn(fs.writeSync) };
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
    expect(contents).toBe(`${JSON.stringify(renewed, null, 2)}\n`.padEnd(before.size, ' '));
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

  it.each(['growing', 'shrinking', 'unicode'])('keeps a %s marker parseable at every renewal IO boundary for allocator readers', async kind => {
    const { lanePath, file } = diskLeaseFixture();
    const lease = { holder, ...(kind === 'shrinking' ? { renewedAt: 'x'.repeat(128) } : {}),
      ...(kind === 'unicode' ? { note: '🍁é' } : {}) };
    writeFileSync(file, JSON.stringify(lease) + (kind === 'unicode' ? ' '.repeat(512) : ''));
    const fs = await vi.importActual('node:fs');
    onTestFinished(() => {
      vi.mocked(ftruncateSync).mockReset().mockImplementation(fs.ftruncateSync);
      vi.mocked(writeSync).mockReset().mockImplementation(fs.writeSync);
    });
    const observations = [];
    const observe = () => {
      try { observations.push(JSON.parse(readFileSync(file, 'utf8'))); }
      catch { observations.push(null); } // lane-pool readLease treats corrupt JSON as an unleased lane.
    };
    vi.mocked(ftruncateSync).mockImplementation((fd, length) => {
      fs.ftruncateSync(fd, length);
      observe();
    });
    vi.mocked(writeSync).mockImplementation((...args) => {
      observe();
      const written = fs.writeSync(...args);
      observe();
      return written;
    });

    expect(defaultRenewLease({ lanePath, holder })).toBe(true);
    expect(defaultRenewLease({ lanePath, holder })).toBe(true);

    expect(observations.length).toBeGreaterThanOrEqual(2);
    expect(observations.every(lease => lease?.holder === holder)).toBe(true);
    expect(readLaneLease(lanePath)).toEqual({ ...lease, renewedAt: expect.any(String) });
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
    vi.mocked(writeSync).mockImplementationOnce((...args) => {
      if (kind === 'deleted') rmSync(file);
      else renameSync(successor, file);
      observedDuringRenewal = readLaneLease(lanePath);
      return fs.writeSync(...args);
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
  it('defaults to renewal at 60 seconds, never earlier, and stops after the agent returns', async () => {
    vi.useFakeTimers();
    onTestFinished(() => vi.useRealTimers());
    const f = fixture();
    delete f.io.heartbeatMs;
    let finish;
    const started = new Promise(resolve => {
      f.spawn.mockImplementation(() => {
        resolve();
        return new Promise(resolveSpawn => { finish = resolveSpawn; });
      });
    });
    const running = runFixCli(argv, f.io);
    await started;
    await vi.advanceTimersByTimeAsync(59_999);
    expect(f.renewLease).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.renewLease).toHaveBeenCalledTimes(1);
    expect(f.renewLease).toHaveBeenCalledWith({ lanePath: f.lanePath, holder });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.renewLease).toHaveBeenCalledTimes(2);
    finish();
    expect((await running).code).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.renewLease).toHaveBeenCalledTimes(2);
  });

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
  it.each([
    ['missing', null], ['foreign', { holder: foreign }], ['missing-holder', {}], ['null-holder', { holder: null }],
  ])('records a %s lease as lease-lost without pushing, staging, aborting or releasing the lane', async (_kind, lease) => {
    const f = fixture();
    const output = [];
    f.io.write = line => output.push(line);
    let callsAfterSpawn;
    f.spawn.mockImplementation(async () => {
      callsAfterSpawn = f.calls.length;
      f.readLease.mockReturnValue(lease);
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
    expect.soft(output.map(classifyFixRunOutcome).filter(Boolean)).toEqual([
      expect.objectContaining({ pr: 5759, outcome: 'lease-lost', infra: false }),
    ]);
    expect.soft(f.calls.some(c => c.args.some(arg => ['push', 'add', 'update-index', 'commit', '--abort'].includes(arg)))).toBe(false);
    expect.soft(f.calls.slice(callsAfterSpawn).some(c =>
        c.args.some(arg => arg.endsWith('lane-pool.mjs'))
        && (c.args.includes('release') || c.args.includes('acquire')))).toBe(false);
    expect(f.renewLease).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', null], ['foreign', { holder: foreign }], ['missing-holder', {}], ['null-holder', { holder: null }],
  ])('does not abort an active launcher merge after %s lease loss', async (_kind, lease) => {
    const f = fixture();
    let merging = false;
    const run = f.run.getMockImplementation();
    f.run.mockImplementation((cmd, args, opts) => {
      if (args.includes('--git-path')) {
        f.calls.push({ cmd, args, opts });
        return 'MERGE_HEAD';
      }
      if (args.includes('merge') && args.includes('--no-commit')) {
        f.calls.push({ cmd, args, opts });
        merging = true;
        f.state.dirty = 'UU file.txt\0';
        throw new Error('merge conflict');
      }
      return run(cmd, args, opts);
    });
    Object.assign(f.io, {
      fileExists: path => path.endsWith('MERGE_HEAD') && merging,
      readFile: () => '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> main\n',
      writeErr: vi.fn(),
    });
    let readsAtLoss;
    f.spawn.mockImplementation(async () => {
      expect(merging).toBe(true);
      readsAtLoss = f.readLease.mock.calls.length;
      f.readLease.mockReturnValue(lease);
    });
    const result = await runFixCli([...argv, '--merge-onto=main'], f.io);
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(result.code).toBe(1);
    expect(f.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'lease-lost' }));
    expect(f.calls.some(c => c.args.includes('--abort'))).toBe(false);
    // One post-agent guard and one release guard; abortMerge must not even be attempted.
    expect(f.readLease.mock.calls.length - readsAtLoss).toBe(2);
    expect(f.io.writeErr.mock.calls.flat().join('')).not.toContain('merge abort failed');
    expect(f.calls.some(c => c.args.includes('release'))).toBe(false);
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
