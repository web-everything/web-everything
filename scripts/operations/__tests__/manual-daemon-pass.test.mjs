import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { manualDaemonPassOperation, validateManualPass, MANUAL_DAEMON_PASS_EFFECT } from '../manual-daemon-pass.mjs';
import { createManualDaemonPassSinks, writeManualPassEvent, readManualDaemonStatus, dispatchManualPass } from '../manual-daemon-pass-io.mjs';
import { parseOperationArgv } from '../cli-adapter.mjs';
import { assertOperatorCliFresh } from '../../lib/main-staleness.mjs';
import { withRealRepo } from './helpers/real-repo.mjs';
import { dispatchReviewJob, dispatchReviewByMode } from '../review-job.mjs';

const input = { daemon: 'review', pr: 7, repo: 'owner/repo', reason: 'daemon is offline', 'force-while-healthy': false };
const sha = 'a'.repeat(40);
const status = (state = 'down', quarantine = null) => ({ daemons: [{ kind: 'review-daemon', state,
  rebuild: { available: true, corrupt: false, state: { quarantine } } }] });
function fixture(overrides = {}) {
  const deps = { readSha: () => sha, assertFresh: vi.fn(), readStatus: () => status(),
    postComment: vi.fn(), dispatch: vi.fn(() => ({ dispatched: true })), appendEvent: vi.fn(),
    now: () => new Date('2026-10-30T12:00:00Z'), ...overrides };
  return { ...deps, run: value => createManualDaemonPassSinks(deps)[MANUAL_DAEMON_PASS_EFFECT](value ?? input) };
}

describe('manual-daemon-pass arguments', () => {
  const argv = ['--daemon=review', '--pr=7', '--repo=owner/repo', '--reason=daemon is offline'];
  it.each(['daemon', 'pr', 'repo', 'reason'])('refuses missing --%s through the generated parser', field => {
    const parsed = parseOperationArgv(manualDaemonPassOperation(), argv.filter(arg => !arg.startsWith(`--${field}=`)));
    expect(parsed.errors.length).toBeGreaterThan(0);
  });
  it.each([
    ['daemon', 'bogus'], ['daemon', 'toString'], ['pr', 0], ['pr', -1], ['pr', 1.5], ['pr', Number.MAX_SAFE_INTEGER + 1],
    ['repo', 'bad'], ['repo', 'a/b/c'], ['repo', 'a/$(whoami)'], ['reason', '   '], ['reason', 'bad\u001btext'],
  ])('refuses invalid %s = %s', (key, value) => {
    expect(() => validateManualPass({ ...input, [key]: value })).toThrow();
  });
  it('parses the exact force flag and all daemon names', () => {
    for (const daemon of ['review', 'red-team', 'fix', 'verify']) {
      const parsed = parseOperationArgv(manualDaemonPassOperation(), [...argv.slice(1), `--daemon=${daemon}`, '--force-while-healthy']);
      expect(parsed.errors).toEqual([]);
      expect(validateManualPass(parsed.input)).toMatchObject({ daemon, 'force-while-healthy': true });
    }
  });
});

describe('manual-daemon-pass admission and audit', () => {
  it('reads the real current checkout HEAD and appends its event through the real filesystem', async () => {
    await withRealRepo(async ({ root, tmp, head }) => {
      const path = join(tmp, 'handoff', 'daemon-events.jsonl');
      const postComment = vi.fn(), dispatch = vi.fn(() => ({ dispatched: true }));
      const sinks = createManualDaemonPassSinks({ cwd: root, env: { WE_DAEMON_EVENTS: path },
        assertFresh: () => {}, readStatus: () => status(), postComment, dispatch });
      await sinks[MANUAL_DAEMON_PASS_EFFECT](input);
      const lines = (await readFile(path, 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({ kind: 'manual-daemon-pass', sha: head(), pr: input.pr,
        result: { status: 'returned', outcome: { dispatched: true } } });
      expect(postComment.mock.calls[0][0].body).toContain(head());
      expect(dispatch).toHaveBeenCalledTimes(1);
    });
  });
  it('defaults freshness and recorded HEAD to the module checkout when cwd is another repository', async () => {
    await withRealRepo(async ({ root }) => {
      const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
      const moduleSha = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
        cwd: moduleRoot, encoding: 'utf8', timeout: 10_000, maxBuffer: 4096,
      }).trim();
      const f = fixture();
      const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
      try {
        const { readSha: _readSha, ...deps } = f;
        await createManualDaemonPassSinks(deps)[MANUAL_DAEMON_PASS_EFFECT](input);
        expect(f.assertFresh).toHaveBeenCalledWith(moduleRoot);
        expect(f.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ sha: moduleSha }));
        expect(f.postComment.mock.calls[0][0].body).toContain(moduleSha);
      } finally { cwd.mockRestore(); }
    });
  });
  it.each(['review', 'red-team'])('wires %s to the daemon export using its default root', async daemon => {
    const dispatchReviewByMode = vi.fn(), dispatchReviewJob = vi.fn();
    const env = {};
    await dispatchManualPass({ ...input, daemon }, { env, load: async () => ({ dispatchReviewByMode, dispatchReviewJob }) });
    const selected = daemon === 'review' ? dispatchReviewByMode : dispatchReviewJob;
    expect(selected).toHaveBeenCalledTimes(1);
    expect(selected).toHaveBeenCalledWith({ pr: 7, repo: input.repo, env,
      ...(daemon === 'red-team' ? { redTeamOnly: true } : {}) });
    expect(daemon === 'review' ? dispatchReviewJob : dispatchReviewByMode).not.toHaveBeenCalled();
  });
  it.each(['job', 'session', 'red-team'])('does not comment when the real %s dispatcher refuses a lane checkout', async mode => {
    const root = join(tmpdir(), 'lane-999999');
    const f = fixture({ dispatch: value => dispatchManualPass(value, { env: {}, load: async () => ({
      dispatchReviewJob: options => dispatchReviewJob({ ...options, root }),
      dispatchReviewByMode: options => dispatchReviewByMode({ ...options, root, mode,
        stackCheck: () => ({ base: null }) }),
    }) }) });
    await expect(f.run({ ...input, repo: 'web-everything/web-everything',
      daemon: mode === 'red-team' ? 'red-team' : 'review' })).rejects.toThrow(/refusing to start a delivery agent from the lane checkout/);
    expect(f.postComment).not.toHaveBeenCalled();
    expect(f.appendEvent).toHaveBeenCalledTimes(1);
  });
  it('refuses a healthy daemon before comment or dispatch, and audits the refusal', async () => {
    const f = fixture({ readStatus: () => status('alive') });
    await expect(f.run()).rejects.toThrow(/healthy/);
    expect(f.postComment).not.toHaveBeenCalled(); expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ result: expect.objectContaining({ status: 'refused' }) }));
  });
  it.each([
    ['forced healthy', 'alive', null, true], ['quarantined', 'alive', { reason: 'smoke failed' }, false],
    ['down', 'down', null, false], ['stalled', 'alive-and-stalled', null, false],
  ])('allows %s and dispatches exactly once', async (_, state, quarantine, force) => {
    const f = fixture({ readStatus: () => status(state, quarantine) });
    await f.run({ ...input, 'force-while-healthy': force });
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(f.dispatch.mock.invocationCallOrder[0]).toBeLessThan(f.postComment.mock.invocationCallOrder[0]);
    expect(f.postComment).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining(`Manual R247 pass — daemon: review; reason: daemon is offline; checkout sha: ${sha}`) }));
  });
  it.each([{}, { daemons: [] }, status('unreadable'), { daemons: [{ kind: 'review-daemon', state: 'down', rebuild: { corrupt: true } }] }])(
    'refuses unknown or unreadable health even with force', async snapshot => {
      const f = fixture({ readStatus: () => snapshot });
      await expect(f.run({ ...input, 'force-while-healthy': true })).rejects.toThrow(/evidence unavailable/);
      expect(f.dispatch).not.toHaveBeenCalled();
    });
  it('does not treat a launchctl read failure as a down daemon', () => {
    expect(() => readManualDaemonStatus({ exec: () => { throw new Error('unavailable'); }, env: { WE_LAUNCH_AGENTS_DIR: join(tmpdir(), 'absent-manual-daemon-plists') } })).toThrow(/launchctl unavailable/);
  });
  it('writes one JSONL event with the R247 fields and shared at envelope', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'manual-daemon-pass-'));
    const path = join(dir, 'events.jsonl');
    try {
      const f = fixture({ appendEvent: event => writeManualPassEvent(event, { env: { WE_DAEMON_EVENTS: path } }) });
      await f.run();
      const lines = (await readFile(path, 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toEqual({ at: '2026-10-30T12:00:00.000Z', ts: '2026-10-30T12:00:00.000Z',
        kind: 'manual-daemon-pass', daemon: 'review', pr: 7, repo: 'owner/repo', reason: input.reason, sha,
        result: { status: 'returned', outcome: { dispatched: true } } });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('uses the shared staleness refusal and never comments or dispatches stale code', async () => {
    const f = fixture({ assertFresh: root => assertOperatorCliFresh(root, {
      skipUnderVitest: false, env: { WE_OPERATOR_CLI_FRESH_FALLBACK: 'off' }, write: () => {},
      listBehindFiles: () => ['scripts/example.mjs'],
      run: args => ({ status: 0, stdout: args[0] === 'rev-list' ? '2' : '' }),
    }) });
    await expect(f.run()).rejects.toThrow(/run from an up-to-date lane/);
    expect(f.postComment).not.toHaveBeenCalled(); expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.appendEvent).toHaveBeenCalledTimes(1);
  });
  it.each(['fix', 'verify'])('names the missing %s entry point without dispatch', async daemon => {
    const f = fixture();
    await expect(f.run({ ...input, daemon })).rejects.toThrow(new RegExp(`no entry point for ${daemon}: missing a single-PR ${daemon} daemon entry point accepting repo/pr`));
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.postComment).not.toHaveBeenCalled();
  });
  it('audits a dispatch error without repeating the pass', async () => {
    const f = fixture({ dispatch: vi.fn(() => { throw new Error('dispatch failed'); }) });
    await expect(f.run()).rejects.toThrow('dispatch failed');
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(f.postComment).not.toHaveBeenCalled();
    expect(f.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ result: { status: 'error', error: 'dispatch failed' } }));
  });
});
