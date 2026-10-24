import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { LANE_GIT_CONFIG_PINS } from '../lane-git-hardening.mjs';

// Intentionally absent in this red-first change: no implementation or import stub.
let salvageStamp, salvageRefName, salvagePushLane, realSalvageIo;
beforeEach(async () => {
  ({ salvageStamp, salvageRefName, salvagePushLane, realSalvageIo } = await import('../lane-pool-salvage-push.mjs'));
});

const date = new Date('2026-01-02T03:04:59.999Z');
const head = 'a'.repeat(40), older = 'b'.repeat(40), other = 'c'.repeat(40);
const ref = 'salvage/lane-7-20260102-0304';
const laneDir = join('pool', 'lane-7');
function harness(overrides = {}) {
  const remote = new Map();
  const io = {
    aheadShas: vi.fn(() => [head, older]),
    unmatchedShas: vi.fn(() => [older]),
    push: vi.fn((_dir, name, sha) => { remote.set(name, sha); return { ok: true }; }),
    remoteSha: vi.fn(name => remote.get(name) ?? null),
    record: vi.fn(),
    ...overrides,
  };
  return { io, remote, run: () => salvagePushLane({ lane: 7, laneDir, io, now: () => date }) };
}

function expectFailed(result, io) {
  expect(result.status).toBe('failed');
  expect(result.reason).toEqual(expect.any(String));
  expect(result.reason.trim()).not.toBe('');
  expect(io.record).not.toHaveBeenCalled();
}

describe('salvage push contract', () => {
  it('formats a zero-padded UTC stamp, discarding seconds', () => {
    expect(salvageStamp(date)).toBe('20260102-0304');
    expect(salvageStamp(new Date('2026-12-31T23:07:00-05:00'))).toBe('20270101-0407');
  });

  it('names an ordinary branch under salvage/lane-N-stamp', () => {
    expect(salvageRefName(7, date)).toBe(ref);
  });

  it('returns none-ahead without pushing when there are no ahead commits', async () => {
    const h = harness({ aheadShas: vi.fn(() => []) });
    expect(await h.run()).toMatchObject({ status: 'none-ahead', unmatched: [] });
    expect(h.io.aheadShas).toHaveBeenCalledWith(laneDir);
    expect(h.io.push).not.toHaveBeenCalled();
    expect(h.io.record).not.toHaveBeenCalled();
  });

  it('returns matched without pushing when every ahead commit is already preserved', async () => {
    const h = harness({ unmatchedShas: vi.fn(() => []) });
    expect(await h.run()).toMatchObject({ status: 'matched', unmatched: [] });
    expect(h.io.unmatchedShas).toHaveBeenCalledWith(laneDir, [head, older]);
    expect(h.io.push).not.toHaveBeenCalled();
    expect(h.io.record).not.toHaveBeenCalled();
  });

  it('pushes HEAD rather than only the unmatched ancestor, with exactly three arguments and no force option', async () => {
    const h = harness();
    expect(await h.run()).toMatchObject({ status: 'pushed', ref, unmatched: [older] });
    expect(h.io.push.mock.calls).toEqual([[laneDir, ref, head]]);
    expect(h.io.push.mock.calls.flat().some(arg => /force|^\+|^-f$/.test(String(arg)))).toBe(false);
  });

  it('checks the remote before pushing, verifies the pushed SHA, then records the ref and SHA exactly once', async () => {
    const h = harness();
    await h.run();
    expect(h.io.remoteSha.mock.calls).toEqual([[ref], [ref]]);
    expect(h.io.remoteSha.mock.invocationCallOrder[0]).toBeLessThan(h.io.push.mock.invocationCallOrder[0]);
    expect(h.io.push.mock.invocationCallOrder[0]).toBeLessThan(h.io.remoteSha.mock.invocationCallOrder[1]);
    expect(h.io.remoteSha.mock.invocationCallOrder[1]).toBeLessThan(h.io.record.mock.invocationCallOrder[0]);
    expect(h.io.record).toHaveBeenCalledTimes(1); expect(h.io.record).toHaveBeenCalledWith(7, expect.stringContaining(ref));
    expect(h.io.record.mock.calls[0][1]).toContain(head);
  });

  it.each([null, other])('fails closed and never records success when verification returns %s', async verifiedSha => {
    const h = harness({ remoteSha: vi.fn().mockReturnValueOnce(null).mockReturnValueOnce(verifiedSha) });
    expectFailed(await h.run(), h.io);
    expect(h.io.push).toHaveBeenCalledTimes(1);
    expect(h.io.remoteSha).toHaveBeenCalledTimes(2);
  });

  it('fails closed with a reason when the push returns ok:false', async () => {
    const h = harness({ push: vi.fn(() => ({ ok: false })) });
    expectFailed(await h.run(), h.io);
    expect(h.io.push).toHaveBeenCalledTimes(1);
  });

  it.each(['aheadShas', 'unmatchedShas', 'push', 'remoteSha'])('contains a %s exception and returns failed with a reason', async method => {
    const h = harness({ [method]: vi.fn(() => { throw new Error(`${method} unavailable`); }) });
    expectFailed(await h.run(), h.io);
  });

  it('contains a record exception rather than claiming a fully recorded push', async () => {
    const h = harness({ record: vi.fn(() => { throw new Error('record unavailable'); }) });
    const result = await h.run();
    expect(result.status).toBe('failed');
    expect(result.reason).toEqual(expect.stringMatching(/\S/));
  });

  it('returns failed without recording when asynchronous verification resolves to a mismatched SHA', async () => {
    const h = harness({ remoteSha: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(other) });
    expectFailed(await h.run(), h.io);
    expect(h.io.push).toHaveBeenCalledTimes(1); expect(h.io.push).toHaveBeenCalledWith(laneDir, ref, head);
    expect(h.io.remoteSha).toHaveBeenCalledTimes(2);
  });

  it('returns failed when the record write rejects despite a verified remote SHA', async () => {
    const h = harness({ record: vi.fn().mockRejectedValue(new Error('record write rejected')) });
    expect(await h.run()).toMatchObject({ status: 'failed', reason: expect.stringContaining('record write rejected') });
    expect(h.io.remoteSha).toHaveReturnedWith(head);
    expect(h.io.record).toHaveBeenCalledTimes(1); expect(h.io.record).toHaveBeenCalledWith(7, `${ref} ${head}\n`);
  });

  it('reports pushed only after remote verification and the pending record write both succeed', async () => {
    let finishRecord, recordStarted;
    const written = new Promise(resolve => { finishRecord = resolve; });
    const started = new Promise(resolve => { recordStarted = resolve; });
    const h = harness({ record: vi.fn(() => { recordStarted(); return written; }) });
    let settled = false;
    const pending = h.run().then(result => { settled = true; return result; });
    await started;
    await Promise.resolve();
    expect(h.io.remoteSha).toHaveReturnedWith(head);
    expect(h.io.record).toHaveBeenCalledTimes(1); expect(h.io.record).toHaveBeenCalledWith(7, `${ref} ${head}\n`);
    expect(settled).toBe(false);
    finishRecord();
    expect(await pending).toMatchObject({ status: 'pushed', ref, unmatched: [older] });
    expect(settled).toBe(true);
  });

  it('fails closed if the remote verification throws after a successful push', async () => {
    const h = harness({ remoteSha: vi.fn().mockReturnValueOnce(null).mockImplementationOnce(() => { throw new Error('verification unavailable'); }) });
    expectFailed(await h.run(), h.io);
    expect(h.io.push).toHaveBeenCalledTimes(1);
  });

  it.each([1, 2])('skips %i occupied names with -2/-3 suffixes and never overwrites them', async occupied => {
    const h = harness();
    const names = [ref, `${ref}-2`, `${ref}-3`];
    for (const name of names.slice(0, occupied)) h.remote.set(name, other);
    const expected = names[occupied];
    expect(await h.run()).toMatchObject({ status: 'pushed', ref: expected });
    expect(h.io.push.mock.calls).toEqual([[laneDir, expected, head]]);
    expect(h.io.remoteSha.mock.calls).toEqual([...names.slice(0, occupied + 1), expected].map(name => [name]));
    for (const name of names.slice(0, occupied)) expect(h.remote.get(name)).toBe(other);
  });

  it('exports realSalvageIo with the five IO functions', () => {
    const io = realSalvageIo({ repo: { name: 'fixture', poolDir: 'pool', referencePath: 'reference', originUrl: 'origin.git', branch: 'main' }, backupRoot: 'backups' });
    for (const method of ['aheadShas', 'unmatchedShas', 'push', 'remoteSha', 'record']) expect(io[method]).toBeTypeOf('function');
  });
});

describe('real salvage preservation and transport', () => {
  const repo = { branch: 'main', originUrl: 'https://example.test/canonical.git', referencePath: 'reference' };
  function realHarness({ cherry = `+ ${head}\n+ ${older}`, contains = '', fail } = {}) {
    const runGit = vi.fn((_command, args) => {
      if (fail && args.includes(fail)) throw new Error(`${fail} unavailable`);
      if (args.includes('rev-list')) return `${head}\n${older}`;
      if (args.includes('cherry')) return cherry;
      if (args.includes('for-each-ref')) return contains;
      return '';
    });
    return { runGit, io: realSalvageIo({ repo, runGit }) };
  }

  it('fetches pruned branch refs and pushes/verifies against the explicit canonical URL with transport pins and hardened env', () => {
    const { io, runGit } = realHarness();
    io.aheadShas(laneDir);
    io.unmatchedShas(laneDir, [head, older]);
    io.push(laneDir, ref, head);
    io.remoteSha(ref);
    for (const command of ['fetch', 'push', 'ls-remote']) {
      const call = runGit.mock.calls.find(([, args]) => args.includes(command));
      expect(call).toBeDefined();
      const [, args, options] = call;
      expect(args).toEqual(expect.arrayContaining([
        '-c', 'remote.origin.uploadpack=git-upload-pack',
        '-c', 'remote.origin.receivepack=git-receive-pack', '-c', 'remote.origin.pushurl=', repo.originUrl,
      ]));
      expect(args).not.toContain('origin');
      for (const [key, value] of LANE_GIT_CONFIG_PINS) {
        const index = Object.keys(options.env).find(k => /^GIT_CONFIG_KEY_\d+$/.test(k) && options.env[k] === key).replace('KEY', 'VALUE');
        expect(options.env[index]).toBe(value);
      }
    }
    const fetchArgs = runGit.mock.calls.find(([, args]) => args.includes('fetch'))[1];
    expect(fetchArgs).toEqual(expect.arrayContaining(['--prune', '--no-tags', '+refs/heads/*:refs/remotes/origin/*']));
    const pushArgs = runGit.mock.calls.find(([, args]) => args.includes('push'))[1];
    expect(pushArgs.slice(pushArgs.indexOf('push'))).toEqual(['push', repo.originUrl, `${head}:refs/heads/${ref}`]);
    expect(runGit.mock.calls.findIndex(([, args]) => args.includes('fetch')))
      .toBeLessThan(runGit.mock.calls.findIndex(([, args]) => args.includes('for-each-ref')));
  });

  it('uses one integration-branch patch check and exact-SHA reachability without enumerating or capping remote refs', () => {
    const { io, runGit } = realHarness({ cherry: `- ${head}\n+ ${older}` });
    expect(io.unmatchedShas(laneDir, [head, older])).toEqual([older]);
    expect(runGit.mock.calls.filter(([, args]) => args.includes('cherry')).map(([, args]) => args))
      .toEqual([['cherry', 'origin/main', 'HEAD']]);
    expect(runGit.mock.calls.filter(([, args]) => args.includes('for-each-ref')).map(([, args]) => args))
      .toEqual([['for-each-ref', '--contains', older, 'refs/remotes/origin', '--count=1']]);
  });

  it('returns matched without pushing when the exact SHAs are reachable from remote branches', async () => {
    const { io, runGit } = realHarness({ contains: 'refs/remotes/origin/work/published' });
    expect(await salvagePushLane({ lane: 7, laneDir, io })).toMatchObject({ status: 'matched', unmatched: [] });
    expect(runGit.mock.calls.some(([, args]) => args.includes('push'))).toBe(false);
    expect(runGit.mock.calls.filter(([, args]) => args.includes('for-each-ref'))).toHaveLength(2);
  });

  it.each(['fetch', 'cherry', 'for-each-ref'])('fails closed without pushing when %s evidence is unreadable', async fail => {
    const { io, runGit } = realHarness({ fail });
    expect(await salvagePushLane({ lane: 7, laneDir, io })).toMatchObject({ status: 'failed', reason: expect.stringContaining(fail) });
    expect(runGit.mock.calls.some(([, args]) => args.includes('push'))).toBe(false);
  });

  it('fails closed with an operator fallback when the canonical origin is unresolved', async () => {
    const runGit = vi.fn(() => head);
    const io = realSalvageIo({ repo: { ...repo, originUrl: null }, runGit });
    expect(await salvagePushLane({ lane: 7, laneDir, io })).toMatchObject({
      status: 'failed', reason: expect.stringContaining('supply --origin or a primary --reference'),
    });
    expect(runGit.mock.calls.map(([, args]) => args)).toEqual([['rev-list', 'origin/main..HEAD']]);
  });
});
