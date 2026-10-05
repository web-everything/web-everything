import { describe, it, expect, vi } from 'vitest';
import { reverifyConfig, runLoadFlakeReverify } from '../load-flake-reverify.mjs';
import { buildLoadFlakeHoldComment } from '../stand-down.mjs';
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
describe('WE_LOAD_FLAKE_REVERIFY_MODE', () => {
  const config = reverifyConfig({ WE_LOAD_FLAKE_REVERIFY_MODE: 'ci' });
  it('defaults to local, accepts ci, and rejects invalid values', () => {
    expect(reverifyConfig({}).mode).toBe('local');
    expect(config.mode).toBe('ci');
    expect(() => reverifyConfig({ WE_LOAD_FLAKE_REVERIFY_MODE: 'bad' })).toThrow('invalid reverify mode');
  });
  it('pushes the saved SHA without verification even under high load, and releases', async () => {
    const { io } = fixture();
    io.loadavg = () => [100, 100];
    expect(await runLoadFlakeReverify({ config }, io)).toEqual({ result: 'pushed', pr: 3881 });
    expect(io.verify).not.toHaveBeenCalled();
    expect(io.prepare).toHaveBeenCalled();
    expect(io.isAncestor).toHaveBeenCalledWith('aaa1111', 'bbb2222');
    expect(io.push).toHaveBeenCalledWith('/lane', 'bbb2222', 'lane/fix');
    expect(io.readPr).toHaveBeenCalledTimes(2);
    expect(io.comment.mock.calls[0][2]).toContain("Pushed without a local re-verify (WE_LOAD_FLAKE_REVERIFY_MODE=ci); the PR's CI judges it.");
    expect(io.release).toHaveBeenCalled();
    expect(await runLoadFlakeReverify({ config: reverifyConfig({}) }, io))
      .toMatchObject({ deferred: 'host-load' });
  });
  it.each(['non-ancestor', 'head-moved', 'lane-head-mismatch'])('still refuses %s', async (reason) => {
    const { io, pr } = fixture();
    if (reason === 'non-ancestor') io.isAncestor.mockReturnValue(false);
    if (reason === 'head-moved') io.readPr.mockResolvedValueOnce(pr).mockResolvedValue({ ...pr, headRefOid: 'moved' });
    if (reason === 'lane-head-mismatch') io.head.mockReturnValue('moved');
    expect(await runLoadFlakeReverify({ config }, io)).toEqual({ deferred: reason });
    expect(io.verify).not.toHaveBeenCalled();
    expect(io.push).not.toHaveBeenCalled();
    if (reason !== 'non-ancestor') expect(io.release).toHaveBeenCalled();
  });
  it('dry-run and no-candidate never touch a lane in ci mode', async () => {
    const { io } = fixture();
    expect(await runLoadFlakeReverify({ config, dryRun: true }, io)).toMatchObject({ dryRun: true });
    expect(io.acquire).not.toHaveBeenCalled();
    io.listPrs.mockResolvedValue([]);
    io.loadavg = () => [100, 100];
    expect(await runLoadFlakeReverify({ config }, io)).toEqual({ deferred: 'no-candidate', dryRun: false });
  });
});
