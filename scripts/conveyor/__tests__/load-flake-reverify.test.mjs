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
      expect(await runLoadFlakeReverify({}, io)).toEqual({ mode: 'local', result });
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
    expect(await runLoadFlakeReverify({}, io)).toEqual({ mode: 'local', deferred: 'non-ancestor' });
    io.pushRefusal.mockReturnValue({ refused: true });
    expect(await runLoadFlakeReverify({}, io)).toEqual({ mode: 'local', deferred: 'fix-claimed' });
    expect(io.acquire).not.toHaveBeenCalled();
  });
  it('rechecks head and claims after verify', async () => {
    for (const moved of [true, false]) {
      const { io, pr } = fixture();
      io.verify.mockImplementation(() => { if (moved) pr.headRefOid = 'new'; else io.pushRefusal.mockReturnValue({ refused: true }); return { ok: true }; });
      // Separate snapshots, as gh would return.
      io.listPrs.mockResolvedValue([structuredClone(pr)]);
      expect(await runLoadFlakeReverify({}, io)).toEqual({ mode: 'local', deferred: moved ? 'head-moved' : 'fix-claimed' });
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
    expect(run.mock.calls[0][1]).toEqual(['-c', 'core.hooksPath=/dev/null', 'push', '--no-verify', 'origin', 'bbb2222:refs/heads/lane/fix']);
    expect(runVerification.mock.calls[0][2]).toMatchObject({ cwd: '/lane', timeoutMs: 2400000 });
    expect(run.mock.calls[1][1]).toContain('--session=owner');
  });
});

import { buildOperatorAnswer } from '../stand-down-answer-core.mjs';
import { loadFlakeLegacyBody } from './load-flake-fixture.mjs';
describe('superseded legacy holds and moved heads (PR #3945 review)', () => {
  const legacy = { ...comment(loadFlakeLegacyBody), id: 'IC_legacy_hold' };
  const answer = { id: 'IC_answer', author: { login: 'web-everything' }, createdAt: '2026-10-04T21:00:00Z',
    body: buildOperatorAnswer({ standDownId: 'IC_legacy_hold', reason: 'handled by hand', actor: 'chalbert', channel: 'test' }) };
  it('an answered legacy hold on an advanced head is never a candidate', () => {
    const pr = { number: 3881, headRefOid: 'advanced', comments: [legacy, answer] };
    expect(planLoadFlakeReverify({ prs: [pr], load: [1, 1], cores: 12, now })).toEqual({ deferred: 'no-candidate' });
    expect(planLoadFlakeReverify({ prs: [{ ...pr, comments: [legacy] }], load: [1, 1], cores: 12, now }).candidate).toBeTruthy();
  });
  it('a hold whose saved alt is no longer a descendant is ended, not retried forever', async () => {
    const { io, pr } = fixture(); io.isAncestor.mockReturnValue(false);
    expect(await runLoadFlakeReverify({}, io)).toEqual({ mode: 'local', deferred: 'non-ancestor' });
    expect(io.comment.mock.calls[0][2]).toContain('result=head-moved');
    const ended = { ...pr, comments: [...pr.comments, comment(io.comment.mock.calls[0][2], '2026-10-04T22:00:01Z')] };
    expect(planLoadFlakeReverify({ prs: [ended], load: [1, 1], cores: 12, now })).toEqual({ deferred: 'no-candidate' });
    expect(io.acquire).not.toHaveBeenCalled();
  });
});

import { scrubVerifyEnv } from '../load-flake-reverify.mjs';
import { loadFlakeHolds } from '../stand-down.mjs';
describe('starvation, deleted alts and credentials (PR #3945 advisory)', () => {
  // Two PRs; the oldest hold is #3881 (fixture default), the younger one is #3882 on its own alt.
  function twoHolds() {
    const { io, pr } = fixture();
    const youngerHold = comment(buildLoadFlakeHoldComment({ head: 'ccc3333', alt: 'lane/other-alt', altSha: 'ddd4444' }), '2026-10-04T20:00:00Z');
    const younger = { number: 3882, state: 'OPEN', headRefName: 'lane/other', headRefOid: 'ccc3333', comments: [youngerHold] };
    io.listPrs.mockResolvedValue([pr, younger]);
    io.readPr.mockImplementation(async (_slug, n) => (n === 3882 ? younger : pr));
    return { io, pr, younger };
  }
  it('a moved alt branch ends its hold and the younger hold is not starved', async () => {
    const { io } = twoHolds();
    io.head.mockImplementation((path) => 'moved-tip'); // lane checked out a newer tip than the recorded sha
    io.resolveSha.mockImplementation((sha) => sha);
    expect(await runLoadFlakeReverify({}, io)).toEqual({ mode: 'local', deferred: 'lane-head-mismatch' });
    expect(io.comment.mock.calls[0][0]).toBe('web-everything/web-everything');
    expect(io.comment.mock.calls[0][1]).toBe(3881);
    expect(io.comment.mock.calls[0][2]).toContain('result=head-moved');
    // The ended hold no longer leads the plan: the next sweep picks the younger hold.
    const { pr, younger } = twoHolds();
    const ended = { ...pr, comments: [...pr.comments, comment(io.comment.mock.calls[0][2], '2026-10-04T22:00:01Z')] };
    expect(planLoadFlakeReverify({ prs: [ended, younger], load: [1, 1], cores: 12, now }).candidate.pr.number).toBe(3882);
  });
  it('a live fix claim or a transient fetch failure on the oldest hold falls through to the younger one', async () => {
    for (const trouble of ['claim', 'fetch']) {
      const { io } = twoHolds();
      if (trouble === 'claim') io.pushRefusal.mockImplementation(({ branch }) => (branch === 'lane/fix' ? { refused: true } : null));
      else io.prepare.mockImplementation((_s, alt) => { if (alt === 'lane/fix-alt') throw new Error('Could not resolve host'); });
      io.head.mockReturnValue('ddd4444'); io.resolveSha.mockReturnValue('ddd4444');
      expect(await runLoadFlakeReverify({}, io)).toEqual({ mode: 'local', result: 'pushed', pr: 3882 });
      expect(io.push).toHaveBeenCalledWith('/lane', 'ddd4444', 'lane/other');
    }
  });
  it('a transient failure on the only hold is still thrown, and posts nothing', async () => {
    const { io } = fixture(); io.prepare.mockImplementation(() => { throw new Error('Could not resolve host: github.com'); });
    await expect(runLoadFlakeReverify({}, io)).rejects.toThrow('Could not resolve host');
    expect(io.comment).not.toHaveBeenCalled();
  });
  it('a hold whose saved alt branch was deleted is ended; a transient fetch failure is not', async () => {
    const { io, pr } = fixture();
    io.prepare.mockImplementation(() => { throw Object.assign(new Error('git fetch failed'), { stderr: "fatal: couldn't find remote ref refs/heads/alt" }); });
    expect(await runLoadFlakeReverify({}, io)).toEqual({ mode: 'local', deferred: 'alt-gone' });
    expect(io.comment.mock.calls[0][2]).toContain('result=head-moved');
    const ended = { ...pr, comments: [...pr.comments, comment(io.comment.mock.calls[0][2], '2026-10-04T22:00:01Z')] };
    expect(planLoadFlakeReverify({ prs: [ended], load: [1, 1], cores: 12, now })).toEqual({ deferred: 'no-candidate' });
  });
  it('verification runs without App credentials and a red summary is redacted before it is posted', async () => {
    const env = scrubVerifyEnv({ PATH: '/bin', HOME: '/h', WE_GITHUB_APP_ID: '1', WE_GITHUB_APP_PRIVATE_KEY_PATH: '/k.pem', GH_TOKEN: 'x', NPM_TOKEN: 'y' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h' });
    const runVerification = vi.fn(async () => ''); const io = defaultReverifyIo({ run: vi.fn(), runVerification, root: '/repo' });
    await io.verify('/lane');
    expect(runVerification.mock.calls[0][2].env).not.toHaveProperty('WE_GITHUB_APP_PRIVATE_KEY_PATH');
    const { io: io2 } = fixture();
    io2.verify.mockReturnValue({ ok: false, summary: 'assertion: ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked' });
    await runLoadFlakeReverify({}, io2);
    expect(io2.comment.mock.calls[0][2]).not.toContain('ghp_abcdefghijklmnop');
  });
  it('holds with an unsafe alt branch or sha are never read', () => {
    const mk = (alt, sha, head = 'aaa1111') => comment(`${buildLoadFlakeHoldComment({ head, alt, altSha: sha })}`);
    for (const [alt, sha] of [['x:refs/heads/main', 'bbb2222'], ['lane/fix-alt', '--exec=x'], ['-oops', 'bbb2222'], ['lane/../main', 'bbb2222'], ['lane/fix-alt', 'main']]) {
      expect(loadFlakeHolds([mk(alt, sha)])).toEqual([]);
    }
    expect(loadFlakeHolds([mk('lane/fix-alt', 'bbb2222', '--bad')])).toEqual([]);
    expect(loadFlakeHolds([mk('lane/fix-alt', 'bbb2222')])).toHaveLength(1);
    const forged = { ...mk('lane/fix-alt', 'bbb2222'), author: { login: 'stranger' } };
    expect(loadFlakeHolds([forged])).toEqual([]);
  });
});

describe('stale verification and push isolation (PR #3945 advisory, round 3)', () => {
  it.each(['red-again', 'exhausted'])('a red %s attempt on a PR that moved during verify posts head-moved, never a terminal result', async (kind) => {
    const reds = kind === 'exhausted' ? [red('2026-10-04T19:00:00Z'), red('2026-10-04T20:00:00Z')] : [];
    const { io, pr } = fixture(reds);
    io.listPrs.mockResolvedValue([structuredClone(pr)]);
    io.verify.mockImplementation(() => { pr.headRefOid = 'new'; return { ok: false, summary: 'timeout' }; });
    expect(await runLoadFlakeReverify({}, io)).toEqual({ mode: 'local', deferred: 'head-moved' });
    expect(io.comment).toHaveBeenCalledTimes(1);
    expect(io.comment.mock.calls[0][2]).toContain('result=head-moved');
    expect(io.comment.mock.calls[0][2]).not.toContain('exhausted');
    expect(io.release).toHaveBeenCalled(); expect(io.push).not.toHaveBeenCalled();
  });
  it('a red final attempt on a hold that was resolved during verify posts nothing', async () => {
    const { io, pr } = fixture([red('2026-10-04T19:00:00Z'), red('2026-10-04T20:00:00Z')]);
    io.listPrs.mockResolvedValue([structuredClone(pr)]);
    io.verify.mockImplementation(() => {
      pr.comments = [...pr.comments, comment(buildLoadFlakeResolvedComment({ altSha: 'bbb2222', result: 'pushed' }), '2026-10-04T21:59:00Z')];
      return { ok: false, summary: 'timeout' };
    });
    expect(await runLoadFlakeReverify({}, io)).toEqual({ mode: 'local', deferred: 'hold-ended' });
    expect(io.comment).not.toHaveBeenCalled();
  });
  it('a red final attempt on a still-current head is still terminal', async () => {
    const { io } = fixture([red('2026-10-04T19:00:00Z'), red('2026-10-04T20:00:00Z')]);
    io.verify.mockReturnValue({ ok: false, summary: 'timeout' });
    expect(await runLoadFlakeReverify({}, io)).toEqual({ mode: 'local', result: 'exhausted' });
  });
  it('the push runs from the daemon checkout with hooks disabled, never from the lane that ran the branch code', () => {
    const run = vi.fn(() => ''); const io = defaultReverifyIo({ run, root: '/repo' });
    io.push('/lane', 'bbb2222', 'lane/fix');
    const [bin, args, opts] = run.mock.calls[0];
    expect(bin).toBe('git');
    expect(opts.cwd).toBe('/repo');
    expect(args).toEqual(expect.arrayContaining(['-c', 'core.hooksPath=/dev/null', '--no-verify', 'origin', 'bbb2222:refs/heads/lane/fix']));
    expect(args.indexOf('-c')).toBeLessThan(args.indexOf('push'));
    expect(args).not.toContain('--force');
  });
});
