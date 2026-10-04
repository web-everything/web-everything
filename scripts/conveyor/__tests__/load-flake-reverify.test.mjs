import { describe, it, expect, vi } from 'vitest';
import { runLoadFlakeReverify, planLoadFlakeReverify, defaultReverifyIo } from '../load-flake-reverify.mjs';
import { buildLoadFlakeHoldComment, buildLoadFlakeResolvedComment } from '../stand-down.mjs';
const now = Date.parse('2026-10-04T22:00:00Z');
const comment = (body, createdAt = '2026-10-04T18:51:50Z') => ({ body, createdAt, author: { login: 'web-everything' } });
const hold = comment(buildLoadFlakeHoldComment({ head: 'aaa1111', alt: 'lane/fix-alt', altSha: 'bbb2222' }));
function fixture(reds = []) {
  const pr = { number: 3881, state: 'OPEN', headRefName: 'lane/fix', headRefOid: 'aaa1111', comments: [hold, ...reds] };
  const io = {
    now: () => now, loadavg: () => [1, 2, 4], cpuCount: () => 12,
    listPrs: vi.fn(async () => [pr]), readPr: vi.fn(async () => pr), pushRefusal: vi.fn(() => null),
    prepare: vi.fn(), isAncestor: vi.fn(() => true), acquire: vi.fn(() => ({ lane: 3, path: '/lane', holder: 'holder' })),
    head: vi.fn(() => 'bbb2222'), resolveSha: vi.fn(() => 'bbb2222'),
    verify: vi.fn(() => ({ ok: true })), release: vi.fn(), push: vi.fn(), comment: vi.fn(),
  };
  return { io, pr };
}
const red = (at) => comment(buildLoadFlakeResolvedComment({ altSha: 'bbb2222', result: 'red-again' }), at);
describe('quiet-host reverify', () => {
  it.each([[20, 1], [1, 20]])('defers on either load average without writes, naming the holds: %j', async (a, b) => {
    const { io } = fixture(); io.loadavg = () => [a, b];
    const out = await runLoadFlakeReverify({}, io);
    expect(out).toMatchObject({ deferred: 'host-load', load: [a, b] });
    expect(out.holds.length).toBeGreaterThan(0); // names the held PRs it evaluated (read-only discovery)
    expect(io.acquire).not.toHaveBeenCalled(); expect(io.comment).not.toHaveBeenCalled(); expect(io.push).not.toHaveBeenCalled();
  });
  it('verifies then pushes the saved SHA and records success, releasing its lane', async () => {
    const { io } = fixture();
    expect(await runLoadFlakeReverify({}, io)).toMatchObject({ result: 'pushed' });
    expect(io.isAncestor).toHaveBeenCalledWith('aaa1111', 'bbb2222');
    expect(io.push).toHaveBeenCalledWith('/lane', 'bbb2222', 'lane/fix');
    expect(io.comment.mock.calls[0][2]).toContain('result=pushed');
    expect(io.release).toHaveBeenCalled(); expect(io.readPr).toHaveBeenCalledTimes(2);
  });
  it('records red-again and caps the third failure', async () => {
    for (const [reds, result] of [[[], 'red-again'], [[red('2026-10-04T19:00:00Z'), red('2026-10-04T20:00:00Z')], 'exhausted']]) {
      const { io } = fixture(reds); io.verify.mockReturnValue({ ok: false, summary: 'x'.repeat(2000) });
      expect(await runLoadFlakeReverify({}, io)).toEqual({ result });
      expect(io.comment.mock.calls[0][2]).toContain(`result=${result}`);
      expect(io.push).not.toHaveBeenCalled(); expect(io.release).toHaveBeenCalled();
    }
  });
  it('respects cooloff', async () => {
    const { io } = fixture([red('2026-10-04T21:45:00Z')]);
    expect(await runLoadFlakeReverify({}, io)).toMatchObject({ deferred: 'no-candidate' });
    expect(io.acquire).not.toHaveBeenCalled();
  });
  it('refuses non-ancestor and live fix claims', async () => {
    const { io } = fixture(); io.isAncestor.mockReturnValue(false);
    expect(await runLoadFlakeReverify({}, io)).toEqual({ deferred: 'non-ancestor' });
    io.pushRefusal.mockReturnValue({ refused: true });
    expect(await runLoadFlakeReverify({}, io)).toEqual({ deferred: 'fix-claimed' });
    expect(io.acquire).not.toHaveBeenCalled();
  });
  it('rechecks head and claims after verify', async () => {
    for (const moved of [true, false]) {
      const { io, pr } = fixture();
      io.verify.mockImplementation(() => { if (moved) pr.headRefOid = 'new'; else io.pushRefusal.mockReturnValue({ refused: true }); return { ok: true }; });
      // Separate snapshots, as gh would return.
      io.listPrs.mockResolvedValue([structuredClone(pr)]);
      expect(await runLoadFlakeReverify({}, io)).toEqual({ deferred: moved ? 'head-moved' : 'fix-claimed' });
      expect(io.push).not.toHaveBeenCalled(); expect(io.release).toHaveBeenCalled();
    }
  });
  it('releases on IO failure and dry-run never acquires or posts', async () => {
    const { io } = fixture();
    await runLoadFlakeReverify({ dryRun: true }, io);
    expect(io.acquire).not.toHaveBeenCalled(); expect(io.comment).not.toHaveBeenCalled();
    io.push.mockRejectedValue(new Error('offline'));
    await expect(runLoadFlakeReverify({}, io)).rejects.toThrow('offline');
    expect(io.release).toHaveBeenCalled();
  });
  it('chooses oldest live hold', () => {
    const { pr } = fixture();
    const younger = { ...pr, number: 2, comments: [{ ...hold, createdAt: '2026-10-04T21:00:00Z' }] };
    expect(planLoadFlakeReverify({ prs: [younger, pr], load: [1, 1], cores: 12, now }).candidate.pr.number).toBe(3881);
  });
  it('IO uses plain push, bounded verification and holder release', async () => {
    const run = vi.fn(() => ''); const runVerification = vi.fn(async () => ''); const io = defaultReverifyIo({ run, runVerification, root: '/repo' });
    io.push('/lane', 'bbb2222', 'lane/fix'); await io.verify('/lane'); io.release({ lane: 3, holder: 'owner' }, 'we');
    expect(run.mock.calls[0][1]).toEqual(['push', 'origin', 'bbb2222:refs/heads/lane/fix']);
    expect(runVerification.mock.calls[0][2]).toMatchObject({ cwd: '/lane', timeoutMs: 2400000 });
    expect(run.mock.calls[1][1]).toContain('--session=owner');
  });
});
