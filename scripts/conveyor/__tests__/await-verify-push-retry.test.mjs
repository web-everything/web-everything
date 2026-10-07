/**
 * Live 2026-10-07 ~16:55Z: GitHub answered the harness push of the verified sha 23142af5 (PR #4244) with
 * `! [remote rejected] ... (Internal Server Error)`. The word "rejected" made the pass call it a MOVED branch and
 * the verified fix was thrown away. These tests drive pushShaFromScratch against REAL git repos and fail on the
 * old code (which neither retried a 5xx nor re-checked a "moved" rejection).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pushShaFromScratch, classifyPushFailure, resolvePushRetryTuning } from '../await-verify-pass.mjs';

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
const identity = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' };
const TUNING = { attempts: 4, baseMs: 10, capMs: 40 };
const dirs = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function mkLane() {
  const root = mkdtempSync(join(tmpdir(), 'await-verify-retry-')); dirs.push(root);
  const origin = join(root, 'origin.git');
  const base = join(root, 'base');
  git(root, ['init', '--bare', '-b', 'main', origin]);
  git(root, ['clone', origin, base]);
  writeFileSync(join(base, 'a.txt'), 'one\n');
  git(base, ['add', 'a.txt']); git(base, [...identity, 'commit', '-m', 'one']); git(base, ['push', 'origin', 'HEAD:main']);
  git(base, ['push', 'origin', 'HEAD:refs/heads/lane/x']);
  const lane = join(root, 'lane');
  git(root, ['clone', '--shared', origin, lane]);
  writeFileSync(join(lane, 'a.txt'), 'one\ntwo\n');
  git(lane, ['add', 'a.txt']); git(lane, [...identity, 'commit', '-m', 'two']);
  return { root, origin, base, lane, sha: git(lane, ['rev-parse', 'HEAD']).trim(), laneGitDir: git(lane, ['rev-parse', '--absolute-git-dir']).trim() };
}

/** Real git, except the first `n` pushes fail with `stderr` (a lost response when `applyFirst`: the push lands, then errors). */
function flaky({ n, stderr, applyFirst = false }) {
  const state = { pushes: 0 };
  const exec = (cmd, args, opts) => {
    if (cmd === 'git' && args.includes('push') && state.pushes < n) {
      state.pushes += 1;
      if (applyFirst) execFileSync(cmd, args, opts);
      throw Object.assign(new Error(stderr), { stderr });
    }
    if (cmd === 'git' && args.includes('push')) state.pushes += 1;
    return execFileSync(cmd, args, opts);
  };
  return { exec, state };
}
const REMOTE_500 = 'To https://github.com/web-everything/web-everything.git\n ! [remote rejected] 23142af52fa0 -> lane/4701-refusal (Internal Server Error)\nerror: failed to push some refs to \'https://github.com/web-everything/web-everything.git\'';

describe('classifyPushFailure', () => {
  it('a [remote rejected] line carrying a 5xx is transient, never "moved"', () => {
    expect(classifyPushFailure(REMOTE_500)).toBe('transient');
    expect(classifyPushFailure('fatal: unable to access: The requested URL returned error: 502')).toBe('transient');
    expect(classifyPushFailure('fatal: Could not resolve host: github.com')).toBe('transient');
    expect(classifyPushFailure('', { killed: true })).toBe('transient');
  });
  it('a real non-fast-forward is moved; a hook decline stays a rejection', () => {
    expect(classifyPushFailure(' ! [rejected] x -> y (fetch first)')).toBe('moved');
    expect(classifyPushFailure(' ! [rejected] x -> y (non-fast-forward)')).toBe('moved');
    expect(classifyPushFailure(' ! [remote rejected] x -> y (protected branch hook declined)')).toBe('rejected');
  });
});

describe('resolvePushRetryTuning knobs', () => {
  it('defaults and overrides, with bad values falling back', () => {
    expect(resolvePushRetryTuning({})).toEqual({ attempts: 4, baseMs: 2000, capMs: 30000 });
    expect(resolvePushRetryTuning({ WE_AWAIT_VERIFY_PUSH_ATTEMPTS: '6', WE_AWAIT_VERIFY_PUSH_BACKOFF_MS: '500', WE_AWAIT_VERIFY_PUSH_BACKOFF_CAP_MS: '900' })).toEqual({ attempts: 6, baseMs: 500, capMs: 900 });
    expect(resolvePushRetryTuning({ WE_AWAIT_VERIFY_PUSH_ATTEMPTS: 'x', WE_AWAIT_VERIFY_PUSH_BACKOFF_MS: '-1' })).toEqual({ attempts: 4, baseMs: 2000, capMs: 30000 });
  });
});

describe('pushShaFromScratch against a flaky GitHub', () => {
  it('retries a 500 with doubling, capped backoff and then lands the verified sha', () => {
    const L = mkLane();
    const { exec, state } = flaky({ n: 3, stderr: REMOTE_500 });
    const waits = [];
    const out = pushShaFromScratch({ laneGitDir: L.laneGitDir, url: L.origin, sha: L.sha, ref: 'lane/x', exec, env: ENV, sleep: (ms) => waits.push(ms), tuning: TUNING });
    expect(out.remote).toBe(L.sha);
    expect(state.pushes).toBe(4);
    expect(waits).toEqual([10, 20, 40]);
    expect(git(L.origin, ['rev-parse', 'refs/heads/lane/x']).trim()).toBe(L.sha);
  });

  it('gives up after the bounded attempts with a transient error (not "moved")', () => {
    const L = mkLane();
    const { exec, state } = flaky({ n: 99, stderr: REMOTE_500 });
    let err;
    try { pushShaFromScratch({ laneGitDir: L.laneGitDir, url: L.origin, sha: L.sha, ref: 'lane/x', exec, env: ENV, sleep: () => {}, tuning: TUNING }); } catch (e) { err = e; }
    expect(err?.pushKind).toBe('transient');
    expect(state.pushes).toBe(4);
  });

  it('a lost response after the push landed is success, not a moved branch', () => {
    const L = mkLane();
    const { exec } = flaky({ n: 1, stderr: ' ! [rejected] x -> lane/x (fetch first)', applyFirst: true });
    const out = pushShaFromScratch({ laneGitDir: L.laneGitDir, url: L.origin, sha: L.sha, ref: 'lane/x', exec, env: ENV, sleep: () => {}, tuning: TUNING });
    expect(out.alreadyThere).toBe(true);
    expect(git(L.origin, ['rev-parse', 'refs/heads/lane/x']).trim()).toBe(L.sha);
  });

  it('a rejection whose remote head is an ancestor of the verified sha is pushed again', () => {
    const L = mkLane();
    const { exec, state } = flaky({ n: 1, stderr: ' ! [rejected] x -> lane/x (fetch first)' });
    const out = pushShaFromScratch({ laneGitDir: L.laneGitDir, url: L.origin, sha: L.sha, ref: 'lane/x', exec, env: ENV, sleep: () => {}, tuning: TUNING });
    expect(out.remote).toBe(L.sha);
    expect(state.pushes).toBe(2);
  });

  it('a remote head someone else moved (not an ancestor) is reported as diverged and never overwritten', () => {
    const L = mkLane();
    writeFileSync(join(L.base, 'b.txt'), 'theirs\n');
    git(L.base, ['add', 'b.txt']); git(L.base, [...identity, 'commit', '-m', 'theirs']); git(L.base, ['push', 'origin', 'HEAD:refs/heads/lane/x']);
    const theirs = git(L.base, ['rev-parse', 'HEAD']).trim();
    let err;
    try { pushShaFromScratch({ laneGitDir: L.laneGitDir, url: L.origin, sha: L.sha, ref: 'lane/x', exec: execFileSync, env: ENV, sleep: () => {}, tuning: TUNING }); } catch (e) { err = e; }
    expect(err).toMatchObject({ pushKind: 'moved', diverged: true, remoteHead: theirs });
    expect(git(L.origin, ['rev-parse', 'refs/heads/lane/x']).trim()).toBe(theirs);
  });
});

// ── the pass: a transient exhaustion keeps the verified sha and the pass retries it on later ticks ──────────
import { runAwaitVerifyPass, buildAwaitVerifyResumePrompt } from '../await-verify-pass.mjs';
import { planSalvage, resolveSalvageTuning, stashCommit, salvageKey, listSalvage, writeSalvage, clearSalvage } from '../verified-push-salvage.mjs';

const SHA = '23142af52fa06fc0d1497286bdc8e74290279421';
const T0 = Date.parse('2026-10-07T16:50:00Z');
const REC = { v: 1, sessionId: 'S1', who: 'fix-4244', repo: 'web-everything/web-everything', pr: 4244, ref: 'lane/4701-refusal', sha: SHA, lane: '/lanes/lane-1', kind: 'fix', attempt: 1, requestedAt: new Date(T0).toISOString() };
const MARKER = { status: 'green', sha: SHA, treeHash: 'T', checkedAt: new Date(T0).toISOString() };

function passIo({ pushResult, salvagePushResults = [] }) {
  const store = new Map([['S1', REC]]);
  const salvage = new Map();
  const calls = { resume: [], salvagePush: 0 };
  const io = {
    listRecords: () => [...store].map(([key, record]) => ({ key, record })),
    writeRecord: (r) => { store.set('S1', r); return { ok: true }; },
    clearRecord: (key) => { store.delete(key); },
    laneState: () => ({ head: SHA, dirty: false, treeHash: 'T' }),
    readMarker: () => MARKER,
    rerequest: () => ({ ok: true }),
    push: () => pushResult,
    listSessions: () => [{ sessionId: 'S1', name: 'fix-4244', cwd: '/s', state: 'done', status: 'idle', kind: 'background' }],
    resume: (a) => { calls.resume.push(a); return { resumed: true }; },
    listSalvage: () => [...salvage].map(([key, record]) => ({ key, record })),
    writeSalvage: (r) => { salvage.set(salvageKey(r), r); return { ok: true }; },
    clearSalvage: (key) => { salvage.delete(key); },
    saveSalvage: ({ record, nowMs, reason }) => { const r = { v: 1, repo: record.repo, pr: record.pr, ref: record.ref, sha: record.sha, savedAt: new Date(nowMs).toISOString(), nextAttemptAt: new Date(nowMs + 60_000).toISOString(), attempts: 0, lastReason: reason }; salvage.set(salvageKey(r), r); return { ok: true }; },
    salvagePush: () => { calls.salvagePush += 1; return salvagePushResults.shift() ?? { ok: false, reason: 'GitHub still failing' }; },
  };
  return { io, store, salvage, calls };
}

describe('a GitHub outage after a green verify', () => {
  it('keeps the verified sha, tells the session it is transient, and later ticks push it', async () => {
    const h = passIo({ pushResult: { ok: false, transient: true, moved: false, reason: 'GitHub was unavailable for 4 push attempt(s): Internal Server Error' }, salvagePushResults: [{ ok: false, reason: 'GitHub still failing' }, { ok: true }] });
    let now = T0 + 60_000;
    // the 3 per-tick push retries, then the exhaustion tick
    const results = [];
    for (let i = 0; i < 4; i += 1) { const { rows } = await runAwaitVerifyPass({ io: h.io, nowMs: now, ttlMs: 3_600_000 }); results.push(...rows.filter((r) => r.action === 'salvage').map((r) => r.result)); now += 120_000; }
    expect(h.calls.resume).toHaveLength(1);
    expect(h.calls.resume[0].prompt).toMatch(/kept failing[\s\S]*saved|kept failing[\s\S]*retrying/i);
    expect(h.calls.resume[0].prompt).toContain('--cause=transient');
    expect(h.calls.resume[0].prompt).not.toMatch(/save to the alt branch/);
    expect(h.salvage.size).toBe(1);
    for (let i = 0; i < 3; i += 1) { const { rows } = await runAwaitVerifyPass({ io: h.io, nowMs: now, ttlMs: 3_600_000 }); results.push(...rows.filter((r) => r.action === 'salvage').map((r) => r.result)); now += 600_000; }
    expect(results.some((r) => /^retry later/.test(r))).toBe(true);
    expect(results.some((r) => /^pushed/.test(r))).toBe(true);
    expect(h.salvage.size).toBe(0);
  });

  it('a salvage whose branch was moved by someone else is dropped with a clear outcome, never pushed', async () => {
    const h = passIo({ pushResult: { ok: true }, salvagePushResults: [{ ok: false, terminal: true, reason: 'lane/4701-refusal was moved by someone else' }] });
    h.salvage.set(salvageKey(REC), { v: 1, repo: REC.repo, pr: 4244, ref: REC.ref, sha: SHA, savedAt: new Date(T0).toISOString(), nextAttemptAt: new Date(T0).toISOString(), attempts: 0 });
    h.store.clear();
    const { rows } = await runAwaitVerifyPass({ io: h.io, nowMs: T0 + 60_000, ttlMs: 3_600_000 });
    expect(rows.find((r) => r.action === 'salvage').result).toMatch(/^dropped: .*moved by someone else/);
    expect(h.salvage.size).toBe(0);
  });

  it('planSalvage drops expired and exhausted records and waits out the cool-off', () => {
    const tuning = resolveSalvageTuning({});
    const base = { savedAt: new Date(T0).toISOString(), attempts: 0 };
    expect(planSalvage(base, { nowMs: T0 + 1000, tuning }).action).toBe('push');
    expect(planSalvage({ ...base, nextAttemptAt: new Date(T0 + 60_000).toISOString() }, { nowMs: T0 + 1000, tuning }).action).toBe('wait');
    expect(planSalvage(base, { nowMs: T0 + tuning.ttlMs + 1, tuning })).toMatchObject({ action: 'drop', reason: 'expired' });
    expect(planSalvage({ ...base, attempts: tuning.maxAttempts }, { nowMs: T0 + 1000, tuning })).toMatchObject({ action: 'drop', reason: 'attempts-exhausted' });
  });

  it('buildAwaitVerifyResumePrompt: push-transient is not the "branch moved" path', () => {
    const p = buildAwaitVerifyResumePrompt({ kind: 'push-transient', record: REC, detail: 'Internal Server Error' });
    expect(p).toContain('temporary GitHub outage');
    expect(p).toContain('--cause=transient');
  });
});

describe('stashCommit keeps the verified commit after the lane is gone', () => {
  it('copies the commit into a daemon-owned repo and a later push works with no lane', () => {
    const L = mkLane();
    const dir = join(L.root, 'salvage');
    const key = salvageKey({ pr: 1, sha: L.sha });
    const out = stashCommit({ exec: execFileSync, laneGitDir: L.laneGitDir, sha: L.sha, key, dir, env: ENV });
    expect(out.ok).toBe(true);
    rmSync(L.lane, { recursive: true, force: true });
    const pushed = pushShaFromScratch({ laneGitDir: out.gitDir, url: L.origin, sha: L.sha, ref: 'lane/x', exec: execFileSync, env: ENV, sleep: () => {}, tuning: TUNING });
    expect(pushed.remote).toBe(L.sha);
  });

  it('store round trip', () => {
    const dir = mkdtempSync(join(tmpdir(), 'salvage-store-')); dirs.push(dir);
    const rec = { v: 1, repo: REC.repo, pr: 4244, ref: REC.ref, sha: SHA, savedAt: new Date(T0).toISOString(), attempts: 0 };
    expect(writeSalvage(rec, { dir }).ok).toBe(true);
    expect(listSalvage({ dir })).toHaveLength(1);
    clearSalvage(salvageKey(rec), { dir });
    expect(listSalvage({ dir })).toHaveLength(0);
  });
});
