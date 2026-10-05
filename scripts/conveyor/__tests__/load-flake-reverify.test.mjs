import { describe, it, expect, vi } from 'vitest';
import os from 'node:os';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { runBounded } from '../../lib/bounded-child.mjs';
import { RUNNER_LOCK_ROOT } from '../../../skills-src/conveyor/runner-lock.mjs';
import { runLoadFlakeReverify, planLoadFlakeReverify, defaultReverifyIo, reverifyConfig, VERIFY_ENV_ALLOWLIST } from '../load-flake-reverify.mjs';
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
    expect(await runLoadFlakeReverify({}, io)).toEqual({ deferred: 'non-ancestor' });
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
    expect(await runLoadFlakeReverify({}, io)).toEqual({ deferred: 'lane-head-mismatch' });
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
      expect(await runLoadFlakeReverify({}, io)).toEqual({ result: 'pushed', pr: 3882 });
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
    expect(await runLoadFlakeReverify({}, io)).toEqual({ deferred: 'alt-gone' });
    expect(io.comment.mock.calls[0][2]).toContain('result=head-moved');
    const ended = { ...pr, comments: [...pr.comments, comment(io.comment.mock.calls[0][2], '2026-10-04T22:00:01Z')] };
    expect(planLoadFlakeReverify({ prs: [ended], load: [1, 1], cores: 12, now })).toEqual({ deferred: 'no-candidate' });
  });
  it('verification runs without App credentials and a red summary is redacted before it is posted', async () => {
    const env = scrubVerifyEnv({ PATH: '/bin', HOME: '/h', WE_GITHUB_APP_ID: '1', WE_GITHUB_APP_PRIVATE_KEY_PATH: '/k.pem', GH_TOKEN: 'x', NPM_TOKEN: 'y' });
    expect(env).toEqual({ PATH: '/bin' });
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
    expect(await runLoadFlakeReverify({}, io)).toEqual({ deferred: 'head-moved' });
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
    expect(await runLoadFlakeReverify({}, io)).toEqual({ deferred: 'hold-ended' });
    expect(io.comment).not.toHaveBeenCalled();
  });
  it('a red final attempt on a still-current head is still terminal', async () => {
    const { io } = fixture([red('2026-10-04T19:00:00Z'), red('2026-10-04T20:00:00Z')]);
    io.verify.mockReturnValue({ ok: false, summary: 'timeout' });
    expect(await runLoadFlakeReverify({}, io)).toEqual({ result: 'exhausted' });
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


describe('verify environment allowlist', () => {
  it('keeps only required knobs and replaces home and temp with scratch paths', () => {
    expect(scrubVerifyEnv({ PATH: '/bin', FAKE_API_KEY: 'x', OPENAI_API_KEY: 'x', SSH_AUTH_SOCK: '/s',
      AWS_ACCESS_KEY_ID: 'x', GH_TOKEN: 'x', HOME: '/Users/real', npm_config__authToken: 'x',
      npm_config_cache: '/c', WE_HEAVY_ADMISSION_CAP: '2', WE_VITEST_MAX_WORKERS: '2',
      npm_config_cert: 'x', npm_config_private_key: 'x', npm_config_userconfig: '/Users/real/.npmrc', npm_config_globalconfig: '/etc/npmrc', NPM_CONFIG_CACHE: '/no', UNKNOWN: 'x',
    }, { scratchDir: '/s' })).toEqual({ PATH: '/bin', npm_config_cache: '/c', WE_HEAVY_ADMISSION_CAP: '2',
      WE_VITEST_MAX_WORKERS: '2', HOME: '/s/home', TMPDIR: '/s/tmp', TMP: '/s/tmp', TEMP: '/s/tmp' });
    expect(Object.isFrozen(VERIFY_ENV_ALLOWLIST)).toBe(true);
  });
  it('reads exact extension names and never extends secret or home access', () => {
    expect(reverifyConfig({ WE_LOAD_FLAKE_VERIFY_ENV_ALLOW: ' MY_KNOB, ,OTHER_KNOB ' }).verifyEnvAllow).toEqual(['MY_KNOB', 'OTHER_KNOB']);
    expect(scrubVerifyEnv({ MY_KNOB: 'yes', MY_KNOB_EXTRA: 'no', MY_API_KEY: 'x', HOME: '/real', TMPDIR: '/real/tmp' },
      { allow: ['MY_KNOB', 'MY_API_KEY', 'HOME', 'TMPDIR'] })).toEqual({ MY_KNOB: 'yes' });
  });
  it.each(['MY_API_KEY', 'NODE_AUTH_TOKEN', 'AWS_ACCESS_KEY_ID', 'SSH_AUTH_SOCK', 'WE_GITHUB_APP_ID'])('rejects secret extension %s', (name) => {
    expect(() => reverifyConfig({ WE_LOAD_FLAKE_VERIFY_ENV_ALLOW: name })).toThrow();
  });
  it.each([
    'npm_config_userconfig', 'npm_config_globalconfig', 'NPM_CONFIG_USERCONFIG', 'NPM_CONFIG_GLOBALCONFIG', 'Npm_Config_UserConfig', 'npm_CONFIG_globalConfig',
  ])('rejects uppercase and mixed-case npm credential-config extensions: %s', (name) => {
    expect(() => reverifyConfig({ WE_LOAD_FLAKE_VERIFY_ENV_ALLOW: name })).toThrow(/npm credential-config/);
    // Defence in depth: even a hand-built allow list that skipped config validation never reaches the child.
    expect(scrubVerifyEnv({ [name]: '/Users/real/.npmrc', PATH: '/bin' }, { allow: [name] })).toEqual({ PATH: '/bin' });
  });
  it('a non-credential npm extension in any case is still allowed', () => {
    expect(reverifyConfig({ WE_LOAD_FLAKE_VERIFY_ENV_ALLOW: 'NPM_CONFIG_CACHE' }).verifyEnvAllow).toEqual(['NPM_CONFIG_CACHE']);
    expect(scrubVerifyEnv({ NPM_CONFIG_CACHE: '/c' }, { allow: ['NPM_CONFIG_CACHE'] })).toEqual({ NPM_CONFIG_CACHE: '/c' });
  });
  it.each(['LANE_POOL_ROOT', 'CONVEYOR_RUNNER_LOCK_ROOT', 'PLAYWRIGHT_BROWSERS_PATH'])('expands a ~-prefixed %s against the real home, not the scratch home', (name) => {
    const env = scrubVerifyEnv({ [name]: '~/workspace/.lanes' }, { scratchDir: '/s', home: '/Users/real' });
    expect(env[name]).toBe('/Users/real/workspace/.lanes');
    expect(env.HOME).toBe('/s/home');
    expect(scrubVerifyEnv({ [name]: '~' }, { home: '/Users/real' })[name]).toBe('/Users/real');
    expect(scrubVerifyEnv({ [name]: '/abs/~/x' }, { home: '/Users/real' })[name]).toBe('/abs/~/x');
    expect(scrubVerifyEnv({ [name]: '~other/x' }, { home: '/Users/real' })[name]).toBe('~other/x');
  });
  it.skipIf(process.getuid?.() === 0)('a scratch cleanup failure never replaces the verify result', async () => {
    const cwd = mkdtempSync(join(os.tmpdir(), 'reverify-test-'));
    let locked;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const io = defaultReverifyIo({ runVerification: async (_bin, _args, opts) => {
        locked = join(opts.env.HOME, 'locked');
        mkdirSync(locked); writeFileSync(join(locked, 'f'), 'x'); chmodSync(locked, 0o000);
      } });
      expect(await io.verify(cwd)).toEqual({ ok: true });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      if (locked) { chmodSync(locked, 0o755); rmSync(dirname(dirname(locked)), { recursive: true, force: true }); }
      rmSync(cwd, { recursive: true, force: true });
    }
  });
  it.each([false, true])('a real verify child has private scratch directories, cleaned even on failure=%s', async (fail) => {
    const cwd = mkdtempSync(join(os.tmpdir(), 'reverify-test-'));
    const realHome = os.homedir();
    let child, during;
    vi.stubEnv('FAKE_API_KEY', 'x'); vi.stubEnv('MY_KNOB', 'yes');
    vi.stubEnv('CONVEYOR_RUNNER_LOCK_ROOT', undefined); vi.stubEnv('PLAYWRIGHT_BROWSERS_PATH', undefined);
    delete process.env.CONVEYOR_RUNNER_LOCK_ROOT; delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    try {
      const io = defaultReverifyIo({ verifyEnvAllow: ['MY_KNOB'], runVerification: async (_bin, _args, opts) => {
        during = [existsSync(opts.env.HOME), existsSync(opts.env.TMPDIR)];
        child = JSON.parse(await runBounded(process.execPath, ['-e',
          'process.stdout.write(JSON.stringify({ keys: Object.keys(process.env), home: process.env.HOME, tmp: process.env.TMPDIR, knob: process.env.MY_KNOB, lock: process.env.CONVEYOR_RUNNER_LOCK_ROOT, browsers: process.env.PLAYWRIGHT_BROWSERS_PATH }))',
        ], { ...opts, timeoutMs: 10_000 }));
        if (fail) throw new Error('verify failed');
      } });
      expect(await io.verify(cwd)).toMatchObject({ ok: !fail });
      expect(child.keys).not.toContain('FAKE_API_KEY');
      expect(child.home).not.toBe(realHome);
      expect(child.knob).toBe('yes');
      expect(child.lock).toBe(RUNNER_LOCK_ROOT);
      expect(child.browsers).toBe(join(realHome, process.platform === 'darwin' ? 'Library/Caches' : '.cache', 'ms-playwright'));
      expect(during).toEqual([true, true]);
      expect(child.tmp).toBe(join(dirname(child.home), 'tmp'));
      expect(existsSync(dirname(child.home))).toBe(false);
    } finally { vi.unstubAllEnvs(); rmSync(cwd, { recursive: true, force: true }); }
  });
});

describe('exact hold revalidation', () => {
  it.each([
    ['lane/new-alt', 'ccc3333'], ['lane/fix-alt', 'ccc3333'], ['lane/new-alt', 'bbb2222'], ['lane/fix-alt', 'bbb2222'],
  ])('a newer hold for %s at %s prevents a stale push or result', async (alt, altSha) => {
    const { io, pr } = fixture();
    const newer = comment(buildLoadFlakeHoldComment({ head: pr.headRefOid, alt, altSha }), '2026-10-04T21:00:00Z');
    io.readPr.mockResolvedValueOnce(pr).mockResolvedValue({ ...pr, comments: [hold, newer] });
    expect(await runLoadFlakeReverify({}, io)).toEqual({ deferred: 'hold-changed' });
    expect(io.verify).toHaveBeenCalled(); expect(io.release).toHaveBeenCalled();
    expect(io.push).not.toHaveBeenCalled(); expect(io.comment).not.toHaveBeenCalled();
  });
  // Every identity field is varied ALONE at an identical createdAt, so each comparison is defended independently.
  it.each([
    ['only the alt branch', 'lane/other-alt', 'bbb2222'],
    ['only the alt sha', 'lane/fix-alt', 'ccc3333'],
  ])('a re-recorded hold at the same createdAt changing %s prevents a stale push or result', async (_label, alt, altSha) => {
    const { io, pr } = fixture();
    const edited = comment(buildLoadFlakeHoldComment({ head: pr.headRefOid, alt, altSha }), hold.createdAt);
    io.readPr.mockResolvedValueOnce(pr).mockResolvedValue({ ...pr, comments: [hold, edited] });
    expect(await runLoadFlakeReverify({}, io)).toEqual({ deferred: 'hold-changed' });
    expect(io.push).not.toHaveBeenCalled(); expect(io.comment).not.toHaveBeenCalled();
  });
  it('a re-recorded hold changing only createdAt prevents a stale push or result', async () => {
    const { io, pr } = fixture();
    const later = comment(buildLoadFlakeHoldComment({ head: pr.headRefOid, alt: 'lane/fix-alt', altSha: 'bbb2222' }), '2026-10-04T21:00:00Z');
    io.readPr.mockResolvedValueOnce(pr).mockResolvedValue({ ...pr, comments: [hold, later] });
    expect(await runLoadFlakeReverify({}, io)).toEqual({ deferred: 'hold-changed' });
    expect(io.push).not.toHaveBeenCalled(); expect(io.comment).not.toHaveBeenCalled();
  });
  it('tries the next candidate when the verified hold changed', async () => {
    const { io, pr } = fixture();
    const younger = { ...pr, number: 3882, comments: [{ ...hold, createdAt: '2026-10-04T21:00:00Z' }] };
    io.listPrs.mockResolvedValue([pr, younger]);
    io.readPr.mockResolvedValueOnce(pr).mockResolvedValueOnce({ ...pr, comments: younger.comments }).mockResolvedValue(younger);
    expect(await runLoadFlakeReverify({}, io)).toEqual({ result: 'pushed', pr: 3882 });
    expect(io.verify).toHaveBeenCalledTimes(2);
    expect(io.comment).toHaveBeenCalledTimes(1);
    expect(io.comment.mock.calls[0][1]).toBe(3882);
  });
});
