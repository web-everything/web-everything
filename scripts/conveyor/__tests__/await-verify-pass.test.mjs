import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, lstatSync, existsSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeWorkingTreeHash } from '../../lib/verify-lane-gate.mjs';
import { laneGitHardeningEnv, hardenLaneGitArgs, laneFilterDrivers, LANE_CONFIG_LIST_ARGS, LANE_GIT_CONFIG_PINS } from '../../lib/lane-git-hardening.mjs';
import {
  classifyAwaitVerdict, isLoadFlakeRed, runAwaitVerifyPass, buildAwaitVerifyResumePrompt, findAwaitSession,
  formatAwaitVerifyLines, isHarnessRecord, AWAIT_VERIFY_LIMITS, pushShaFromScratch, claimBindingRefusal, isSessionBusy, defaultAwaitVerifyIo,
} from '../await-verify-pass.mjs';

const SHA = '65a382e81413952ab11e5448e36f01bb7ce4c332';
const OTHER = 'b96574995e22b8d8087d4a28b7ba7615d4ec8c73';
const TREE = 'f'.repeat(64);
const T0 = Date.parse('2026-10-06T19:55:10.847Z');
const TTL = 150 * 60_000;
const rec = (over = {}) => ({
  v: 1, sessionId: '0c5f3830-1522-49ab-8f20-e4108ccc926b', who: 'fix-4115', repo: 'web-everything/web-everything',
  pr: 4115, sha: SHA, requestedAt: new Date(T0).toISOString(), attempt: 1,
  lane: '/lanes/lane-5', ref: 'lane/item-68b', kind: 'fix', ...over,
});
const lane = (over = {}) => ({ head: SHA, dirty: false, treeHash: TREE, ...over });
const marker = (status, over = {}) => ({ sha: SHA, status, startedAt: new Date(T0).toISOString(), treeHash: TREE, exitCode: status === 'green' ? 0 : status === 'red' ? 1 : null, ...over });
const classify = (over = {}) => classifyAwaitVerdict({ record: rec(), marker: marker('running'), lane: lane(), nowMs: T0 + 60_000, ttlMs: TTL, ...over });

describe('classifyAwaitVerdict — the policy table', () => {
  it('running → wait', () => expect(classify()).toMatchObject({ action: 'wait' }));
  it('running past the record TTL → re-request', () => expect(classify({ nowMs: T0 + TTL + 1 })).toMatchObject({ action: 'rerequest', reason: 'verify-overdue' }));
  it('green for the exact sha, same tree, clean lane → push', () => expect(classify({ marker: marker('green') })).toMatchObject({ action: 'push' }));
  it('green whose tree hash differs from the lane now → re-request, never push', () => {
    expect(classify({ marker: marker('green', { treeHash: 'e'.repeat(64) }) })).toMatchObject({ action: 'rerequest', reason: 'tree-unproven' });
    expect(classify({ marker: marker('green', { treeHash: null }) })).toMatchObject({ action: 'rerequest' });
    expect(classify({ marker: marker('green'), lane: lane({ treeHash: null }) })).toMatchObject({ action: 'rerequest' });
  });
  it('green for another sha → re-request (exact-sha only, no carry-forward)', () => {
    expect(classify({ marker: marker('green', { sha: OTHER }) })).toMatchObject({ action: 'rerequest' });
  });
  it('lane moved, dirty or unreadable → resume void, never push', () => {
    expect(classify({ marker: marker('green'), lane: lane({ head: OTHER }) })).toMatchObject({ action: 'resume', resume: 'void' });
    expect(classify({ marker: marker('green'), lane: lane({ dirty: true }) })).toMatchObject({ action: 'resume', resume: 'void' });
    expect(classify({ marker: marker('green'), lane: null })).toMatchObject({ action: 'resume', resume: 'void' });
  });
  it('real red → resume red; third red → escalate', () => {
    expect(classify({ marker: marker('red') })).toMatchObject({ action: 'resume', resume: 'red' });
    expect(classify({ marker: marker('red'), record: rec({ attempt: 3 }) })).toMatchObject({ action: 'resume', resume: 'escalate' });
  });
  it('load-only red → load-flake in WE, a plain red elsewhere', () => {
    const flaky = marker('red', { retriedFailures: [{ file: 'a.test.mjs', kind: 'timeout' }], isolatedRetry: 'still-red', failureDetails: { tests: [{ file: 'a.test.mjs', name: 'x' }] } });
    expect(classify({ marker: flaky })).toMatchObject({ action: 'resume', resume: 'load-flake' });
    expect(classify({ marker: flaky, record: rec({ repo: 'plateauapp/plateau-app' }) })).toMatchObject({ resume: 'red' });
  });
  it('infrastructure failure / absent / corrupt → re-request, then infra after the retry budget', () => {
    for (const m of [marker('infrastructure-failure'), null, { corrupt: true }]) {
      expect(classify({ marker: m })).toMatchObject({ action: 'rerequest' });
      expect(classify({ marker: m, record: rec({ retries: AWAIT_VERIFY_LIMITS.maxRetries }) })).toMatchObject({ action: 'resume', resume: 'infra' });
    }
  });
  it('a slice-1 record (no lane/ref/kind) or an unsafe ref is not the pass\'s to act on', () => {
    expect(classify({ record: rec({ lane: undefined }) })).toMatchObject({ action: 'skip' });
    for (const ref of ['main', 'refs/heads/main', '--force', 'lane/../main']) expect(isHarnessRecord(rec({ ref }))).toBe(false);
    expect(isHarnessRecord(rec({ kind: 'build' }))).toBe(false);
  });
  it('THE GATE: across every marker status and lane state, push is answered only for an exact-sha green on the same clean tree', () => {
    const statuses = ['running', 'green', 'red', 'infrastructure-failure', 'untracked', 'break-glass'];
    for (const status of statuses) for (const sha of [SHA, OTHER]) for (const head of [SHA, OTHER]) for (const dirty of [false, true])
      for (const treeHash of [TREE, 'e'.repeat(64), null]) {
        const d = classify({ marker: marker(status, { sha }), lane: lane({ head, dirty, treeHash }) });
        const allowed = status === 'green' && sha === SHA && head === SHA && !dirty && treeHash === TREE;
        expect(d.action === 'push', JSON.stringify({ status, sha, head, dirty, treeHash })).toBe(allowed);
      }
  });
});

it('isLoadFlakeRed needs every failure to be a retried timeout', () => {
  expect(isLoadFlakeRed(marker('red'))).toBe(false);
  expect(isLoadFlakeRed(marker('red', { retriedFailures: [{ file: 'a', kind: 'assertion' }] }))).toBe(false);
  expect(isLoadFlakeRed(marker('red', { retriedFailures: [{ file: 'a', kind: 'timeout' }], failureDetails: { tests: [{ file: 'b' }] } }))).toBe(false);
});

it('findAwaitSession binds by session id, else the newest row with the who name', () => {
  const rows = [{ sessionId: 'x', name: 'fix-4115', startedAt: 1 }, { sessionId: 'y', name: 'fix-4115', startedAt: 2 }];
  expect(findAwaitSession(rec({ sessionId: 'x' }), rows).sessionId).toBe('x');
  expect(findAwaitSession(rec({ sessionId: null }), rows).sessionId).toBe('y');
  expect(findAwaitSession(rec({ sessionId: 'z', who: 'fix-1' }), rows)).toBeNull();
});

it('resume prompts never begin with "-" and the green one forbids a second push', () => {
  for (const kind of ['green', 'push-rejected', 'red', 'load-flake', 'escalate', 'infra', 'void', 'other']) {
    const p = buildAwaitVerifyResumePrompt({ kind, record: rec(), marker: marker('red', { failureDetails: { tests: [{ file: 'a.test.mjs', name: 'b' }] } }) });
    expect(p.startsWith('[harness verify verdict')).toBe(true);
    expect(p).toContain(SHA);
  }
  expect(buildAwaitVerifyResumePrompt({ kind: 'green', record: rec() })).toMatch(/Do not push lane\/item-68b again/);
  expect(buildAwaitVerifyResumePrompt({ kind: 'red', record: rec(), marker: marker('red', { failureDetails: { tests: [{ file: 'a.test.mjs', name: 'b' }] } }) })).toContain('a.test.mjs > b');
});

/** An in-memory harness: one store, one lane, one session, scripted marker states. */
function harness({ records = [rec()], session = { sessionId: rec().sessionId, name: 'fix-4115', cwd: '/scratch', state: 'done' }, pushResult = { ok: true }, resumeResult = { resumed: true } } = {}) {
  const store = new Map(records.map((r) => [r.sessionId ?? r.who, r]));
  const calls = { push: [], resume: [], rerequest: [] };
  const state = { marker: marker('running'), lane: lane() };
  const io = {
    listRecords: () => [...store.entries()].map(([key, record]) => ({ key, record })),
    writeRecord: (r) => { store.set(r.sessionId ?? r.who, r); return { ok: true }; },
    clearRecord: (key) => { store.delete(key); },
    laneState: () => state.lane,
    readMarker: () => state.marker,
    rerequest: (l) => { calls.rerequest.push(l); state.marker = marker('running'); return { ok: true, status: 'requested' }; },
    push: (a) => { calls.push.push(a); return typeof pushResult === 'function' ? pushResult(a) : pushResult; },
    listSessions: () => (session ? [session] : []),
    resume: (a) => { calls.resume.push(a); return typeof resumeResult === 'function' ? resumeResult(a) : resumeResult; },
  };
  return { io, store, calls, state };
}

describe('runAwaitVerifyPass', () => {
  it('green → pushes the exact sha to the recorded ref, then resumes the SAME session and clears the record', async () => {
    const h = harness();
    h.state.marker = marker('green');
    const { rows } = await runAwaitVerifyPass({ io: h.io, nowMs: T0 + 60_000, ttlMs: TTL });
    expect(h.calls.push).toEqual([expect.objectContaining({ sha: SHA, ref: 'lane/item-68b', lane: '/lanes/lane-5', who: 'fix-4115' })]);
    expect(h.calls.resume).toHaveLength(1);
    expect(h.calls.resume[0].session.sessionId).toBe(rec().sessionId);
    expect(h.calls.resume[0].prompt).toMatch(/harness has PUSHED it to lane\/item-68b/);
    expect(h.store.size).toBe(0);
    expect(rows[0]).toMatchObject({ action: 'push', result: 'pushed; resumed:green' });
  });
  it('red → never pushes; resumes with the failing tests', async () => {
    const h = harness();
    h.state.marker = marker('red', { failureDetails: { tests: [{ file: 'skills-src/conveyor/__tests__/daemon-log-dedupe.test.mjs', name: 'interleave' }] } });
    await runAwaitVerifyPass({ io: h.io, nowMs: T0 + 60_000, ttlMs: TTL });
    expect(h.calls.push).toEqual([]);
    expect(h.calls.resume[0].prompt).toContain('daemon-log-dedupe.test.mjs > interleave');
    expect(h.calls.resume[0].prompt).toContain('--attempt=2');
  });
  it('a rejected push resumes with push-rejected; a transient one retries the push next tick', async () => {
    const h = harness({ pushResult: { ok: false, moved: true, reason: '! [rejected] (non-fast-forward)' } });
    h.state.marker = marker('green');
    await runAwaitVerifyPass({ io: h.io, nowMs: T0 + 60_000, ttlMs: TTL });
    expect(h.calls.resume[0].prompt).toMatch(/could NOT push/);
    // a refusal that is NOT a moved branch (claim held, PR closed, fork…) never tells the session to rebase and re-mark
    const refused = harness({ pushResult: { ok: false, reason: 'PR #4115 is not open' } });
    refused.state.marker = marker('green');
    await runAwaitVerifyPass({ io: refused.io, nowMs: T0 + 60_000, ttlMs: TTL });
    expect(refused.calls.resume[0].prompt).toMatch(/did NOT push[\s\S]*not a moved branch[\s\S]*blocked-on-infra/);
    expect(refused.calls.resume[0].prompt).not.toMatch(/reconcile|alt branch/i);
    const t = harness({ pushResult: { ok: false, transient: true, reason: 'Could not resolve host' } });
    t.state.marker = marker('green');
    const { rows } = await runAwaitVerifyPass({ io: t.io, nowMs: T0 + 60_000, ttlMs: TTL });
    expect(rows[0].result).toMatch(/^push-retry/);
    expect(t.calls.resume).toEqual([]);
    expect([...t.store.values()][0].pushRetries).toBe(1); // its own budget: verify re-requests do not eat the push retries
    expect([...t.store.values()][0].retries).toBeUndefined();
  });
  it('a busy session or a paused login keeps the pending resume; the next tick delivers it without re-pushing', async () => {
    const h = harness({ session: { sessionId: rec().sessionId, name: 'fix-4115', cwd: '/s', state: 'working' } });
    h.state.marker = marker('green');
    await runAwaitVerifyPass({ io: h.io, nowMs: T0 + 60_000, ttlMs: TTL, allowResume: false });
    expect(h.calls.push).toHaveLength(1);
    expect([...h.store.values()][0].pendingResume.kind).toBe('green');
    await runAwaitVerifyPass({ io: h.io, nowMs: T0 + 180_000, ttlMs: TTL });
    expect(h.calls.resume).toEqual([]); // still busy
    h.io.listSessions = () => [{ sessionId: rec().sessionId, name: 'fix-4115', cwd: '/s', state: 'done' }];
    await runAwaitVerifyPass({ io: h.io, nowMs: T0 + 300_000, ttlMs: TTL });
    expect(h.calls.push).toHaveLength(1);
    expect(h.calls.resume).toHaveLength(1);
    expect(h.store.size).toBe(0);
  });
  it('failed resumes are retried, then the record is dropped (the session becomes reapable)', async () => {
    const h = harness({ resumeResult: { resumed: false, reason: 'forked-copy-stopped' } });
    h.state.marker = marker('red');
    for (let i = 0; i < AWAIT_VERIFY_LIMITS.maxResumeFailures; i += 1) await runAwaitVerifyPass({ io: h.io, nowMs: T0 + i * 120_000, ttlMs: TTL });
    expect(h.calls.resume).toHaveLength(AWAIT_VERIFY_LIMITS.maxResumeFailures);
    expect(h.store.size).toBe(0);
  });
  it('a record whose session is not live is dropped WITHOUT a push (the session id is what the claim binding compares)', async () => {
    const h = harness({ session: null });
    h.state.marker = marker('green');
    const { rows } = await runAwaitVerifyPass({ io: h.io, nowMs: T0 + 60_000, ttlMs: TTL });
    expect(rows[0].result).toBe('session-gone; not pushed');
    expect(h.calls.push).toEqual([]);
    expect(h.store.size).toBe(0);
  });
  it('a session that vanishes AFTER the push still drops the record (the push already happened)', async () => {
    const h = harness();
    h.state.marker = marker('green');
    const sessions = [[{ sessionId: rec().sessionId, name: 'fix-4115', cwd: '/s', state: 'done' }], []];
    h.io.listSessions = () => sessions.length > 1 ? sessions.shift() : sessions[0];
    const { rows } = await runAwaitVerifyPass({ io: h.io, nowMs: T0 + 60_000, ttlMs: TTL });
    expect(rows[0].result).toBe('pushed; session-gone');
    expect(h.store.size).toBe(0);
  });
  it('logs one line per action and a waiting count', async () => {
    expect(formatAwaitVerifyLines({ rows: [{ action: 'wait' }, { action: 'push', repo: 'r', pr: 1, sha: SHA, reason: 'green', result: 'pushed' }] }))
      .toEqual(['await-verify: r PR #1 @ 65a382e8 — push (green) → pushed', 'await-verify: 1 session(s) awaiting a verdict']);
  });
});

/**
 * REPLAY — fix-4115, session 0c5f3830 (2026-10-06), reconstructed from its transcript. It made three verify requests:
 *   R1 19:55:10 on 65a382e8 → 20:04:15 `timeout` → 20:13:20 `timeout` → 20:21:41 green
 *   R2 20:22:48 (tree edited again, same HEAD) → 20:31:49 `timeout` → 20:37:05 red (1 failed)
 *   R3 20:37:14 (repair) → 20:46:17 `timeout` → 20:54:55 green → commit b9657499 → `git push`
 * Old flow: 4 × 9-minute `check --wait` timeouts with the turn held open (~51 min of the session idling in tool
 * calls), and the pushed sha b9657499 was never itself named by a verdict (it verified a dirty tree, then committed).
 * New flow (daemon tick every 120 s; the fixer commits before each request, so each request names its own commit):
 * every `running` sample is a zero-turn wait, there are no re-requests, R2's red resumes the SAME session once with
 * the failure, and each push names exactly the sha its own green verdict covered.
 */
describe('replay: fix-4115 through the harness-owned wait', () => {
  const at = (iso) => Date.parse(`2026-10-06T${iso}Z`);
  const R2_SHA = 'c'.repeat(40); // R2's tree had no commit of its own in the real run; under the new flow it is one
  const requests = [
    { sha: SHA, requested: at('19:55:10'), settled: at('20:21:41'), status: 'green' },
    { sha: R2_SHA, requested: at('20:22:48'), settled: at('20:37:05'), status: 'red',
      failureDetails: { tests: [{ file: 'skills-src/conveyor/__tests__/daemon-log-dedupe.test.mjs', name: 'interleaved rows' }] } },
    { sha: OTHER, requested: at('20:37:14'), settled: at('20:54:55'), status: 'green' },
  ];

  it('no timeout loop, the red resumes once, and every push is the exact sha its green verdict covered', async () => {
    const h = harness({ records: [] });
    const resumes = [];
    let current = -1;
    let waits = 0;
    h.io.resume = (a) => { resumes.push(a.prompt.split('\n')[2] ?? ''); return { resumed: true }; };
    for (let t = at('19:55:00'); t <= at('21:05:00'); t += 120_000) {
      // The fixer side: at each real request time it commits, requests and marks, then ends its turn.
      const next = requests[current + 1];
      if (next && t >= next.requested && h.store.size === 0) {
        current += 1;
        h.store.set(rec().sessionId, rec({ sha: next.sha, attempt: current === 2 ? 2 : 1, requestedAt: new Date(next.requested).toISOString() }));
      }
      const r = requests[current];
      if (!r) continue;
      h.state.lane = lane({ head: r.sha });
      h.state.marker = t >= r.settled
        ? marker(r.status, { sha: r.sha, ...(r.failureDetails ? { failureDetails: r.failureDetails } : {}) })
        : marker('running', { sha: r.sha });
      const { rows } = await runAwaitVerifyPass({ io: h.io, nowMs: t, ttlMs: TTL });
      waits += rows.filter((x) => x.action === 'wait').length;
    }
    expect(h.calls.rerequest).toEqual([]); // no timeout retries: `running` is simply waited out by the harness
    expect(waits).toBeGreaterThan(15); // ~51 min of waiting absorbed by daemon ticks, zero model turns
    expect(resumes.map((p) => p.match(/GREEN|RED/)?.[0])).toEqual(['GREEN', 'RED', 'GREEN']);
    expect(h.calls.push.map((p) => p.sha)).toEqual([SHA, OTHER]); // never the red sha
    expect(h.store.size).toBe(0);
  });
});

describe('findAwaitSession — an explicit session id never falls back by name (#5137 review)', () => {
  it('does not fall back by name when a recorded session id is missing', () => {
    const replacement = [{ sessionId: 'new', name: 'fix-4115', startedAt: 9 }];
    expect(findAwaitSession(rec({ sessionId: 'old', who: 'fix-4115' }), replacement)).toBeNull();
  });
});

describe('defaultAwaitVerifyIo — the real push and resume ports (#5137 review)', () => {
  const PR_HEAD = 'lane/item-68b';
  const PR_URL = 'https://github.com/chalbert/web-everything/pull/4115';
  const REMOTE_URL = 'https://github.com/chalbert/web-everything.git';
  const LANE_GIT_DIR = '/lanes/lane-5/.git';
  /** An exec double that records every call and answers git/gh like a healthy host. */
  const fakeExec = ({ head = PR_HEAD, state = 'OPEN', remote = SHA, failPush = null, cross = 'false', failLsRemote = false } = {}) => {
    const calls = [];
    const exec = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === 'gh') { if (head === null) throw new Error('gh down'); return `${state} ${PR_URL} ${cross} ${head}\n`; }
      if (args.includes('push')) { if (failPush) throw Object.assign(new Error(failPush), { stderr: failPush }); return ''; }
      if (args.includes('ls-remote')) { if (failLsRemote) throw new Error('network blip'); return `${remote}\trefs/heads/${PR_HEAD}\n`; }
      if (args.includes('--absolute-git-dir')) return `${LANE_GIT_DIR}\n`;
      return '';
    };
    return { exec, calls };
  };
  const pushArg = (over = {}) => ({ lane: '/lanes/lane-5', sha: SHA, ref: PR_HEAD, repo: 'web-everything/web-everything', pr: 4115, who: 'fix-4115', sessionId: 'S', ...over });
  const build = async (exec, over = {}) => (await import('../await-verify-pass.mjs')).defaultAwaitVerifyIo({
    weRoot: '/we', exec, env: {}, poolRoot: '/lanes', realpath: (p) => p, pushRefusalFn: () => null, readClaimFn: () => ({ meta: { sessionId: 'S', branch: PR_HEAD } }), ...over,
  });
  const gitPushes = (calls) => calls.filter((c) => c[0] === 'git' && c.includes('push'));

  it('pushes sha:refs/heads/<ref> only — never --force, --no-verify or a + refspec — with the lane config pinned', async () => {
    const { exec, calls } = fakeExec();
    const result = (await build(exec)).push(pushArg());
    expect(result).toEqual({ ok: true });
    const [push] = gitPushes(calls);
    // the push target is the URL GitHub reports for the PR's repo — never the lane's own `origin` (agent-writable config)
    expect(push).toEqual(expect.arrayContaining(['push', REMOTE_URL, `${SHA}:refs/heads/${PR_HEAD}`]));
    expect(push).not.toContain('origin');
    for (const arg of push) {
      expect(arg).not.toMatch(/^--force|^-f$|--no-verify|--force-with-lease/);
      expect(arg).not.toMatch(/^\+/);
    }
    // it runs from a daemon-owned scratch repo (lane objects via alternates), so no lane config is ever read by the push
    expect(push).not.toContain('-C');
    const gitDir = push[push.indexOf('--git-dir') + 1];
    expect(gitDir).toBeTruthy();
    expect(gitDir).not.toBe(LANE_GIT_DIR);
    expect(push).toEqual(expect.arrayContaining(['core.hooksPath=/dev/null']));
    // every lane-side git call neutralizes the lane-config keys that execute code (a hooks path would still run lane-relative scripts)
    for (const c of calls.filter((x) => x[0] === 'git' && x.includes('-C'))) {
      expect(c).toEqual(expect.arrayContaining(['core.fsmonitor=false', 'core.hooksPath=/dev/null', 'core.attributesFile=/dev/null', 'core.sshCommand=ssh']));
      expect(c).not.toContain('diff.external='); // `-c diff.external=` makes every `git diff` die ("cannot run ''"): the tree hash would always be null
    }
  });

  it('refuses any ref outside lane/* at the push port — a push to main never depends on a hook', async () => {
    for (const ref of ['main', 'refs/heads/main', 'lane/../main', '--force', 'master']) {
      const { exec, calls } = fakeExec({ head: ref });
      const result = (await build(exec)).push(pushArg({ ref }));
      expect(result, ref).toMatchObject({ ok: false });
      expect(result.transient).toBeUndefined();
      expect(gitPushes(calls)).toEqual([]);
    }
  });

  it('refuses a fork PR (its head branch is not in the base repo), without pushing', async () => {
    const { exec, calls } = fakeExec({ cross: 'true' });
    expect((await build(exec)).push(pushArg())).toMatchObject({ ok: false, reason: expect.stringMatching(/fork/) });
    expect(gitPushes(calls)).toEqual([]);
  });

  it('a push that succeeded but whose ls-remote read-back failed is ok (not reported to the agent as a rejection)', async () => {
    const { exec } = fakeExec({ failLsRemote: true });
    expect((await build(exec)).push(pushArg())).toEqual({ ok: true });
  });

  it('only a git rejection (or a remote at another sha) is `moved`; refusals and network errors are not', async () => {
    expect(await (await build(fakeExec({ failPush: '! [rejected] (fetch first)' }).exec)).push(pushArg())).toMatchObject({ moved: true });
    expect((await build(fakeExec({ remote: OTHER }).exec)).push(pushArg())).toMatchObject({ ok: false, moved: true });
    expect((await build(fakeExec({ state: 'MERGED' }).exec)).push(pushArg()).moved).toBeUndefined();
    expect(await (await build(fakeExec({ failPush: 'fatal: Could not resolve host' }).exec)).push(pushArg())).toMatchObject({ transient: true, moved: false });
  });

  it('refuses a PR URL that is not a github.com pull URL, without pushing', async () => {
    const calls = [];
    const exec = (cmd, args) => { calls.push([cmd, ...args]); return cmd === 'gh' ? `OPEN https://evil.example/o/r/pull/4115 false ${PR_HEAD}\n` : ''; };
    const result = (await build(exec)).push(pushArg());
    expect(result).toMatchObject({ ok: false });
    expect(gitPushes(calls)).toEqual([]);
  });

  it('a live fix claim held by another session short-circuits before any git or gh call', async () => {
    const { exec, calls } = fakeExec();
    const io = await build(exec, { pushRefusalFn: () => ({ refused: true, message: 'held by fix-9' }) });
    expect(io.push(pushArg())).toEqual({ ok: false, reason: 'held by fix-9' });
    expect(calls).toEqual([]);
  });

  it('refuses a recorded ref that is not the PR\'s head (ref/PR mismatch table), without pushing', async () => {
    for (const ref of ['lane/other-item', 'lane/item-68b-alt', 'lane/ITEM-68B']) {
      const { exec, calls } = fakeExec();
      // the claim names whatever branch the record typed, so it is the PR-head binding (not the claim binding) that refuses here
      const result = (await build(exec, { readClaimFn: () => ({ meta: { sessionId: 'S', branch: ref } }) })).push(pushArg({ ref }));
      expect(result.ok).toBe(false);
      expect(result.transient).toBeUndefined();
      expect(result.reason).toMatch(/not PR #4115's head/);
      expect(gitPushes(calls)).toEqual([]);
    }
  });

  it('refuses to push to a PR that is no longer open', async () => {
    const { exec, calls } = fakeExec({ state: 'MERGED' });
    expect((await build(exec)).push(pushArg())).toMatchObject({ ok: false, reason: expect.stringMatching(/not open/) });
    expect(gitPushes(calls)).toEqual([]);
  });

  it('an unresolvable PR head is a transient refusal (retried), never a push', async () => {
    const { exec, calls } = fakeExec({ head: null });
    const result = (await build(exec)).push(pushArg());
    expect(result).toMatchObject({ ok: false, transient: true });
    expect(gitPushes(calls)).toEqual([]);
  });

  it('a rejected (non-fast-forward) push is terminal, and a remote that did not take the sha is not ok', async () => {
    const rejected = fakeExec({ failPush: '! [rejected] (non-fast-forward)' });
    expect(await (await build(rejected.exec)).push(pushArg())).toMatchObject({ ok: false, transient: false });
    const stale = fakeExec({ remote: OTHER });
    expect((await build(stale.exec)).push(pushArg())).toMatchObject({ ok: false, reason: expect.stringMatching(/after push/) });
  });

  it('classifies a REAL multi-line git rejection (advice hints last) as terminal, and a network failure as transient', async () => {
    const real = [
      'To github.com:chalbert/web-everything.git',
      ' ! [rejected]            65a382e8 -> lane/item-68b (fetch first)',
      'error: failed to push some refs to \'github.com:chalbert/web-everything.git\'',
      'hint: Updates were rejected because the remote contains work that you do',
      'hint: not have locally. This is usually caused by another repository pushing',
      'hint: to the same ref. You may want to first integrate the remote changes',
      'hint: (e.g., \'git pull ...\') before pushing again.',
      'hint: See the \'Note about fast-forwards\' in \'git push --help\' for details.',
    ].join('\n');
    const rejected = await (await build(fakeExec({ failPush: real }).exec)).push(pushArg());
    expect(rejected).toMatchObject({ ok: false, transient: false });
    expect(rejected.reason).toMatch(/rejected/); // the reason a human reads is the rejection, not the trailing hint
    expect(rejected.reason).not.toMatch(/^hint:/);
    const net = await (await build(fakeExec({ failPush: 'fatal: unable to access \'https://github.com/x.git/\': Could not resolve host: github.com' }).exec)).push(pushArg());
    expect(net).toMatchObject({ ok: false, transient: true });
  });

  describe('resume cleanup', () => {
    const session = { sessionId: 'S-target', cwd: '/scratch', state: 'stopped' }; // already stopped: no pre-resume stop
    const dispatchIo = (printed, resumed) => ({
      buildAgentArgv: () => ['--resume'], defaultSpawnAgent: () => `backgrounded ${printed}`,
      parseBackgroundedId: () => printed, defaultListAgents: () => [], resumeSucceeded: () => ({ resumed }),
    });
    const run = async (printed, resumed) => {
      const stopped = [];
      const io = await build(fakeExec().exec, { dispatchIo: dispatchIo(printed, resumed), stopSessionFn: (a) => stopped.push(a.handle), sleep: () => {} });
      return { result: io.resume({ session, prompt: 'p' }), stopped };
    };

    it('never stops the requested session after an unconfirmed resume that printed its own id', async () => {
      const { result, stopped } = await run('S-target', false);
      expect(stopped).toEqual([]);
      expect(result).toMatchObject({ resumed: false, reason: 'resume-unconfirmed' });
    });
    it('stops a forked copy (a different printed id) when the resume is unconfirmed', async () => {
      const { result, stopped } = await run('S-fork', false);
      expect(stopped).toEqual(['S-fork']);
      expect(result).toMatchObject({ resumed: false, reason: 'forked-copy-stopped' });
    });
    it('a confirmed resume stops nothing', async () => {
      const { result, stopped } = await run('S-target', true);
      expect(stopped).toEqual([]);
      expect(result.resumed).toBe(true);
    });
  });
});

describe('resume prompts follow the session\'s OWN brief, for both kinds (#5137 review)', () => {
  const FIX_ONLY = /before\/after|hand-back|"push rejected because the branch moved"|alt branch|record the pause/i;
  it('a CI-heal green resume points at the durable CI-heal tally comment, never the fix brief\'s evidence/hand-back', () => {
    const p = buildAwaitVerifyResumePrompt({ kind: 'green', record: rec({ kind: 'ci-heal' }) });
    expect(p).toMatch(/CI-heal brief/);
    expect(p).toMatch(/ci-heal-mark\.mjs|CI-heal comment/);
    expect(p).not.toMatch(FIX_ONLY);
  });
  it('a CI-heal push-rejected resume says reconcile with the current head, commit, request + mark again — no alt branch or pause', () => {
    const p = buildAwaitVerifyResumePrompt({ kind: 'push-rejected', record: rec({ kind: 'ci-heal' }), detail: '! [rejected] (fetch first)' });
    expect(p).toMatch(/reconcile with the current PR head/i);
    expect(p).toMatch(/--attempt=2/);
    expect(p).not.toMatch(FIX_ONLY);
    expect(p).not.toMatch(/fix-end/);
  });
  it('the fix kind keeps its own evidence/hand-back and alt-branch paths', () => {
    expect(buildAwaitVerifyResumePrompt({ kind: 'green', record: rec() })).toMatch(/before\/after evidence/);
    expect(buildAwaitVerifyResumePrompt({ kind: 'push-rejected', record: rec(), detail: 'x' })).toMatch(/alt branch/);
  });
  it('every resume kind for both kinds names its own brief and the sha, and never tells the session to push the ref itself', () => {
    for (const kind of ['green', 'push-rejected', 'red', 'load-flake', 'escalate', 'infra', 'void', 'other']) {
      for (const k of ['fix', 'ci-heal']) {
        const p = buildAwaitVerifyResumePrompt({ kind, record: rec({ kind: k, attempt: 2 }), detail: 'd', marker: marker('red') });
        expect(p, `${kind}/${k}`).toContain(SHA);
        if (kind === 'green' || kind === 'push-rejected') expect(p, `${kind}/${k}`).toContain(k === 'ci-heal' ? 'CI-heal brief' : 'fix brief');
      }
    }
  });
});

describe('real git: the daemon\'s lane tree hash equals the one verify-lane records, and the push never reads lane config (#5137 review)', () => {
  const git = (cwd, args, env = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', ...env } });
  const identity = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
  /** origin (bare) ← base clone with main pushed ← a lane clone (`--shared`: its objects chain to the base via alternates) with one local commit. */
  const mkLane = () => {
    const root = mkdtempSync(join(tmpdir(), 'await-verify-real-'));
    const origin = join(root, 'origin.git');
    const base = join(root, 'base');
    git(root, ['init', '--bare', '-b', 'main', origin]);
    git(root, ['clone', origin, base]);
    writeFileSync(join(base, 'a.txt'), 'one\n');
    git(base, ['add', 'a.txt']); git(base, [...identity, 'commit', '-m', 'one']); git(base, ['push', 'origin', 'HEAD:main']);
    const lane = join(root, 'lane');
    git(root, ['clone', '--shared', origin, lane]);
    writeFileSync(join(lane, 'a.txt'), 'one\ntwo\n');
    git(lane, ['add', 'a.txt']); git(lane, [...identity, 'commit', '-m', 'two']);
    return { root, origin, lane, sha: git(lane, ['rev-parse', 'HEAD']).trim() };
  };
  const dirs = [];
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

  it('laneState().treeHash equals computeWorkingTreeHash with verify-lane\'s TRIMMING git runner, for a lane with a real diff', async () => {
    const L = mkLane(); dirs.push(L.root);
    writeFileSync(join(L.lane, 'new.txt'), 'untracked\n'); // untracked content is part of the hash too
    const verifyLaneRunner = (a) => git(L.lane, a).trim(); // scripts/verify-lane.mjs: `git(...).trim()`
    const expected = computeWorkingTreeHash({ runGit: verifyLaneRunner, fileMode: (f) => lstatSync(join(L.lane, f)).mode });
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
    // (the lane is dirty because of new.txt; commit it so laneState computes a hash)
    const io = await (await import('../await-verify-pass.mjs')).defaultAwaitVerifyIo({ weRoot: '/we', poolRoot: tmpdir(), env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
    expect(io.laneState(L.lane)).toMatchObject({ dirty: true, treeHash: null });
    git(L.lane, ['add', 'new.txt']); git(L.lane, [...identity, 'commit', '-m', 'three']);
    const committed = computeWorkingTreeHash({ runGit: verifyLaneRunner, fileMode: (f) => lstatSync(join(L.lane, f)).mode });
    const state = io.laneState(L.lane);
    expect(state.dirty).toBe(false);
    expect(state.treeHash).toBe(committed);
  });

  it('no lane-config driver (diff.external, filter clean/smudge, textconv, via an in-repo .gitattributes) ever runs in the daemon, clean OR dirty lane, and the hash is unchanged', async () => {
    const L = mkLane(); dirs.push(L.root);
    const io = await (await import('../await-verify-pass.mjs')).defaultAwaitVerifyIo({ weRoot: '/we', poolRoot: tmpdir(), env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
    writeFileSync(join(L.lane, '.gitattributes'), 'a.txt filter=ev diff=ev\n');
    git(L.lane, ['add', '.gitattributes']); git(L.lane, [...identity, 'commit', '-m', 'attrs']);
    const before = io.laneState(L.lane).treeHash;
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    const ran = join(L.root, 'driver-ran');
    const driver = join(L.root, 'driver.sh');
    writeFileSync(driver, `#!/bin/sh\ntouch ${ran}\ncat\n`, { mode: 0o755 });
    for (const [k, v] of [['diff.external', driver], ['filter.ev.clean', driver], ['filter.ev.smudge', driver], ['diff.ev.textconv', driver]]) git(L.lane, ['config', k, v]);
    // stat-dirty the tracked file (same content, new mtime) so git has to re-read it through any clean filter
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(L.lane, 'a.txt'), future, future);
    expect(io.laneState(L.lane).treeHash).toBe(before);
    writeFileSync(join(L.lane, 'a.txt'), 'edited\n'); // dirty lane
    expect(io.laneState(L.lane)).toMatchObject({ dirty: true, treeHash: null });
    expect(existsSync(ran)).toBe(false);
  });

  it('the lane\'s info/exclude keeps untracked-file selection equal to verify-lane\'s, so the hash still matches', async () => {
    const L = mkLane(); dirs.push(L.root);
    writeFileSync(join(L.lane, 'litter.tmp'), 'x\n');
    writeFileSync(join(L.lane, '.git', 'info', 'exclude'), '*.tmp\n');
    const verifyLaneRunner = (a) => git(L.lane, a).trim();
    const expected = computeWorkingTreeHash({ runGit: verifyLaneRunner, fileMode: (f) => lstatSync(join(L.lane, f)).mode });
    const io = await (await import('../await-verify-pass.mjs')).defaultAwaitVerifyIo({ weRoot: '/we', poolRoot: tmpdir(), env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
    expect(io.laneState(L.lane)).toMatchObject({ dirty: false, treeHash: expected });
  });

  it('pushShaFromScratch pushes the lane commit (objects via alternates) to the GIVEN url, ignoring a lane config that points origin and insteadOf elsewhere', () => {
    const L = mkLane(); dirs.push(L.root);
    const decoy = join(L.root, 'decoy.git');
    git(L.root, ['init', '--bare', decoy]);
    git(L.lane, ['config', 'remote.origin.url', decoy]);
    git(L.lane, ['config', 'remote.origin.pushurl', decoy]);
    git(L.lane, ['config', `url.${decoy}.insteadOf`, L.origin]);
    const laneGitDir = git(L.lane, ['rev-parse', '--absolute-git-dir']).trim();
    const out = pushShaFromScratch({ laneGitDir, url: L.origin, sha: L.sha, ref: 'lane/item-1', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
    expect(out.remote).toBe(L.sha);
    expect(git(L.origin, ['rev-parse', 'refs/heads/lane/item-1']).trim()).toBe(L.sha);
    expect(git(decoy, ['for-each-ref']).trim()).toBe(''); // the lane's own origin / insteadOf was never consulted
  });

  it('pushShaFromScratch never overwrites a moved branch (no force): a non-fast-forward is rejected', () => {
    const L = mkLane(); dirs.push(L.root);
    const laneGitDir = git(L.lane, ['rev-parse', '--absolute-git-dir']).trim();
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' };
    pushShaFromScratch({ laneGitDir, url: L.origin, sha: L.sha, ref: 'lane/item-2', env });
    git(L.lane, ['checkout', '-b', 'other', 'HEAD~1']); writeFileSync(join(L.lane, 'a.txt'), 'other\n');
    git(L.lane, ['add', 'a.txt']); git(L.lane, [...identity, 'commit', '-m', 'other']);
    const other = git(L.lane, ['rev-parse', 'HEAD']).trim();
    expect(() => pushShaFromScratch({ laneGitDir, url: L.origin, sha: other, ref: 'lane/item-2', env })).toThrow();
    expect(git(L.origin, ['rev-parse', 'refs/heads/lane/item-2']).trim()).toBe(L.sha);
  });

  it('rerequest never executes a lane-config command (core.fsmonitor / diff.external) in the daemon — the verify-lane child runs git in the lane', async () => {
    const L = mkLane(); dirs.push(L.root);
    writeFileSync(join(L.lane, 'a.txt'), 'one\ntwo\nthree\n'); // a dirty worktree makes git consult the index/fsmonitor and diff
    const ran = join(L.root, 'ran');
    const driver = join(L.root, 'driver.sh');
    writeFileSync(driver, `#!/bin/sh\ntouch ${ran}-$$\ncat\n`, { mode: 0o755 });
    for (const k of ['core.fsmonitor', 'diff.external']) git(L.lane, ['config', k, driver]);
    const weRoot = process.cwd(); // vitest runs from the repo root; the child is the checkout's own verify-lane.mjs
    expect(existsSync(join(weRoot, 'scripts', 'verify-lane.mjs'))).toBe(true);
    const io = await (await import('../await-verify-pass.mjs')).defaultAwaitVerifyIo({ weRoot, poolRoot: tmpdir(), env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
    const result = io.rerequest(L.lane);
    expect(result.status, JSON.stringify(result)).toBeTruthy(); // verify-lane really ran against the lane (requested, refused or blocked — all after its git reads)
    expect(readdirSync(L.root).filter((f) => f.startsWith('ran-'))).toEqual([]);
  });

  it('rerequest refuses a lane whose own config defines a clean filter — nothing runs, and verify-lane is never spawned', async () => {
    const L = mkLane(); dirs.push(L.root);
    const ran = join(L.root, 'ran');
    const driver = join(L.root, 'driver.sh');
    writeFileSync(driver, `#!/bin/sh\ntouch ${ran}-$$\ncat\n`, { mode: 0o755 });
    git(L.lane, ['config', 'filter.x.clean', driver]);
    writeFileSync(join(L.lane, '.git', 'info', 'attributes'), '* filter=x\n'); // not switchable from the environment
    writeFileSync(join(L.lane, 'a.txt'), 'one\ntwo\nthree\n');
    const spawned = [];
    const exec = (cmd, args, opts) => { spawned.push(args.join(' ')); return execFileSync(cmd, args, opts); };
    const io = await (await import('../await-verify-pass.mjs')).defaultAwaitVerifyIo({ weRoot: process.cwd(), exec, poolRoot: tmpdir(), env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
    expect(io.rerequest(L.lane)).toMatchObject({ ok: false, status: 'lane-refused', reason: expect.stringMatching(/filter\.x\.clean/) });
    expect(spawned.some((a) => a.includes('verify-lane.mjs'))).toBe(false);
    expect(readdirSync(L.root).filter((f) => f.startsWith('ran-'))).toEqual([]);
  });

  it('every port refuses a lane path outside the lane pool (a record\'s lane is agent-typed)', async () => {
    const L = mkLane(); dirs.push(L.root);
    const io = await (await import('../await-verify-pass.mjs')).defaultAwaitVerifyIo({
      weRoot: process.cwd(), poolRoot: join(L.root, 'somewhere-else'), pushRefusalFn: () => null, readClaimFn: () => ({ meta: { sessionId: 'S', branch: 'lane/x' } }),
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
    });
    expect(io.laneState(L.lane)).toBeNull();
    expect(io.readMarker(L.lane)).toBeNull();
    expect(io.rerequest(L.lane)).toMatchObject({ ok: false, status: 'lane-refused' });
    expect(io.push({ lane: L.lane, sha: L.sha, ref: 'lane/x', repo: 'web-everything/web-everything', pr: 1, who: 'w', sessionId: 'S' }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/not inside the lane pool/) });
  });
});

describe('laneFilterDrivers (#5137 review)', () => {
  const entry = (scope, key, value = 'v') => `${scope}\0${key}\n${value}\0`;
  it('names local/worktree filter drivers (any name, any case of the subsection, dotted names) and ignores global ones', () => {
    const out = entry('system', 'filter.lfs.clean') + entry('global', 'filter.lfs.smudge') + entry('local', 'core.bare', 'false')
      + entry('local', 'filter.x.clean') + entry('local', 'filter.Y.process') + entry('worktree', 'filter.a.b.smudge') + entry('local', 'filter.x.required', 'true');
    expect(laneFilterDrivers(out)).toEqual(['filter.x.clean', 'filter.Y.process', 'filter.a.b.smudge']);
    expect(laneFilterDrivers('')).toEqual([]);
  });
  it('sees a driver defined in a file the lane config includes (real git)', () => {
    const root = mkdtempSync(join(tmpdir(), 'await-verify-incl-'));
    try {
      const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
      git('init', '-q');
      writeFileSync(join(root, 'extra.cfg'), '[filter "z"]\n\tclean = evil\n');
      git('config', 'include.path', join(root, 'extra.cfg'));
      expect(laneFilterDrivers(git(...LANE_CONFIG_LIST_ARGS))).toEqual(['filter.z.clean']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('lane-git-hardening (#5137 review)', () => {
  it('pins every code-executing lane-config key through git\'s environment, after any existing GIT_CONFIG_COUNT entries', () => {
    const env = laneGitHardeningEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'x', GIT_EXTERNAL_DIFF: '/evil' });
    expect(env.GIT_CONFIG_COUNT).toBe(String(1 + LANE_GIT_CONFIG_PINS.length));
    expect([env.GIT_CONFIG_KEY_0, env.GIT_CONFIG_VALUE_0]).toEqual(['user.name', 'x']);
    const pins = LANE_GIT_CONFIG_PINS.map((_, i) => [env[`GIT_CONFIG_KEY_${1 + i}`], env[`GIT_CONFIG_VALUE_${1 + i}`]]);
    expect(pins).toEqual(LANE_GIT_CONFIG_PINS.map(([k, v]) => [k, v]));
    expect(LANE_GIT_CONFIG_PINS.map(([k]) => k)).toEqual(expect.arrayContaining(['core.fsmonitor', 'core.hooksPath', 'core.attributesFile', 'core.sshCommand']));
    expect(env.GIT_EXTERNAL_DIFF).toBeUndefined();
    expect(laneGitHardeningEnv({}).GIT_CONFIG_COUNT).toBe(String(LANE_GIT_CONFIG_PINS.length));
  });
  it('rewrites a diff to never run diff.external / textconv and a hash-object to never run a clean filter', () => {
    expect(hardenLaneGitArgs(['diff', '--name-only', 'HEAD'])).toEqual(['diff', '--no-ext-diff', '--no-textconv', '--name-only', 'HEAD']);
    expect(hardenLaneGitArgs(['diff', '--no-ext-diff', '--name-only'])).toEqual(['diff', '--no-textconv', '--no-ext-diff', '--name-only']);
    expect(hardenLaneGitArgs(['hash-object', 'f'])).toEqual(['hash-object', '--no-filters', 'f']);
    expect(hardenLaneGitArgs(['hash-object', '--no-filters', 'f'])).toEqual(['hash-object', '--no-filters', 'f']);
    expect(hardenLaneGitArgs(['rev-parse', 'HEAD'])).toEqual(['rev-parse', 'HEAD']);
  });
});

describe('push binds the record to a constellation repo and a fix claim this session holds (#5137 review)', () => {
  const claim = (over = {}) => ({ meta: { sessionId: 'S', branch: 'lane/item-68b', ...over } });
  const read = (c) => () => c;
  const base = { repo: 'web-everything/web-everything', pr: 4115, ref: 'lane/item-68b', sessionId: 'S' };
  it.each([
    ['a repo outside the constellation', { repo: 'attacker/other-repo' }, claim(), /not a constellation repo/],
    ['no repo at all', { repo: undefined }, claim(), /not a constellation repo/],
    ['a record with no session id', { sessionId: null }, claim(), /no session id/],
    ['no fix claim for that PR', {}, null, /no fix claim/],
    ['a claim held by another session', {}, claim({ sessionId: 'someone-else' }), /not held by this session/],
    ['a claim with no session binding', {}, claim({ sessionId: null }), /not held by this session/],
    ['a claim for another branch', {}, claim({ branch: 'lane/other-pr' }), /is for branch lane\/other-pr/],
  ])('refuses %s', (_name, over, held, message) => {
    expect(claimBindingRefusal({ ...base, ...over, readClaim: read(held) })).toMatch(message);
  });
  it('accepts the claim bound to this session and branch, including a lapsed one nobody re-claimed', () => {
    expect(claimBindingRefusal({ ...base, readClaim: read(claim()) })).toBeNull();
  });
  it('a throwing claim store refuses (fail closed)', () => {
    expect(claimBindingRefusal({ ...base, readClaim: () => { throw new Error('io'); } })).toMatch(/no fix claim/);
  });
  it('the push port refuses an unclaimed other-PR record before any gh or git call, whatever the PR head says', async () => {
    const calls = [];
    const exec = (cmd, args) => { calls.push([cmd, ...args]); return ''; };
    const io = await (await import('../await-verify-pass.mjs')).defaultAwaitVerifyIo({ weRoot: '/we', exec, env: {}, pushRefusalFn: () => null, readClaimFn: () => null, poolRoot: '/lanes', realpath: (p) => p });
    const result = io.push({ lane: '/lanes/lane-5', sha: SHA, ref: 'lane/someone-elses-pr', repo: 'web-everything/web-everything', pr: 9999, who: 'fix-4115', sessionId: 'S' });
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/no fix claim/) });
    expect(result.transient).toBeUndefined();
    expect(result.moved).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe('a failed store write or delete never repeats an effect (#5137 review)', () => {
  const failingWrites = (h) => { h.io.writeRecord = () => ({ ok: false, reason: 'write-failed' }); };
  it('verify re-request: a failed counter write skips the request, so a dead store cannot re-request every tick', async () => {
    const h = harness();
    failingWrites(h);
    h.state.marker = null; // no verdict → re-request
    for (let i = 0; i < 5; i += 1) await runAwaitVerifyPass({ io: h.io, nowMs: T0 + 60_000 + i * 120_000, ttlMs: TTL });
    expect(h.calls.rerequest).toEqual([]);
  });
  it('re-request: with a working store the retry budget still bounds it (≤ maxRetries, then the infra resume)', async () => {
    const h = harness();
    h.io.rerequest = (l) => { h.calls.rerequest.push(l); return { ok: true, status: 'requested' }; };
    h.state.marker = null;
    for (let i = 0; i < 6; i += 1) await runAwaitVerifyPass({ io: h.io, nowMs: T0 + 60_000 + i * 120_000, ttlMs: TTL });
    expect(h.calls.rerequest).toHaveLength(AWAIT_VERIFY_LIMITS.maxRetries);
    expect(h.calls.resume).toHaveLength(1);
  });
  it('green push: the attempt is persisted first; if it cannot be, nothing is pushed or resumed', async () => {
    const h = harness();
    failingWrites(h);
    h.state.marker = marker('green');
    const { rows } = await runAwaitVerifyPass({ io: h.io, nowMs: T0 + 60_000, ttlMs: TTL });
    expect(h.calls.push).toEqual([]);
    expect(h.calls.resume).toEqual([]);
    expect(rows[0].result).toMatch(/persist-failed/);
  });
  it('transient push failures are bounded even though each attempt is counted before the push', async () => {
    const h = harness({ pushResult: { ok: false, transient: true, reason: 'Could not resolve host' } });
    h.state.marker = marker('green');
    for (let i = 0; i < 6; i += 1) await runAwaitVerifyPass({ io: h.io, nowMs: T0 + 60_000 + i * 120_000, ttlMs: TTL });
    expect(h.calls.push).toHaveLength(AWAIT_VERIFY_LIMITS.maxRetries + 1);
    expect(h.calls.resume).toHaveLength(1);
    expect(h.calls.resume[0].prompt).toMatch(/did NOT push/);
  });
  it('a pending resume that cannot be saved is not delivered; the unsaved red re-decides next tick', async () => {
    const h = harness();
    failingWrites(h);
    h.state.marker = marker('red');
    const { rows } = await runAwaitVerifyPass({ io: h.io, nowMs: T0 + 60_000, ttlMs: TTL });
    expect(h.calls.resume).toEqual([]);
    expect(rows[0].result).toMatch(/persist-failed/);
  });
  it('resume attempts are counted before the resume, so an unwritable store cannot retry a failing resume forever', async () => {
    const h = harness({ resumeResult: { resumed: false, reason: 'unconfirmed' } });
    h.state.marker = marker('red');
    let writes = 0;
    const write = h.io.writeRecord;
    h.io.writeRecord = (r) => (++writes <= 1 ? write(r) : { ok: false }); // only the pending-resume write succeeds
    for (let i = 0; i < 5; i += 1) await runAwaitVerifyPass({ io: h.io, nowMs: T0 + 60_000 + i * 120_000, ttlMs: TTL });
    expect(h.calls.resume).toEqual([]);
  });
  it('a record that cannot be deleted after a resume is never resumed or pushed again', async () => {
    const h = harness();
    h.io.clearRecord = () => ({ cleared: false });
    h.state.marker = marker('green');
    const unclearable = new Set();
    for (let i = 0; i < 4; i += 1) await runAwaitVerifyPass({ io: h.io, nowMs: T0 + 60_000 + i * 120_000, ttlMs: TTL, resumedUnclearable: unclearable });
    expect(h.calls.push).toHaveLength(1);
    expect(h.calls.resume).toHaveLength(1);
    const { rows } = await runAwaitVerifyPass({ io: h.io, nowMs: T0 + 900_000, ttlMs: TTL, resumedUnclearable: unclearable });
    expect(rows[0].result).toMatch(/record-clear-failed/);
  });
});

it('isSessionBusy reads the live turn signal: a turn-ended bg session is state working + status idle (live 2026-10-07)', () => {
  expect(isSessionBusy({ state: 'working', status: 'idle' })).toBe(false);
  expect(isSessionBusy({ state: 'working', status: 'busy' })).toBe(true);
  expect(isSessionBusy({ state: 'stopped' })).toBe(false);
  expect(isSessionBusy({ state: 'working' })).toBe(true);
});

it('resume stops the idle live process by its SHORT job id first, then resumes the same session id (live 2026-10-07)', async () => {
  const calls = [];
  const sid = 'a287c608-48e3-4d38-99f1-10496475407f';
  const io = await defaultAwaitVerifyIo({
    sleep: () => {},
    pidAliveFn: () => false,
    stopSessionFn: ({ handle }) => { calls.push(['stop', handle]); return { stopped: true }; },
    dispatchIo: {
      buildAgentArgv: ({ resumeSessionId }) => ['--bg', '--resume', resumeSessionId],
      parseBackgroundedId: () => sid,
      resumeSucceeded: () => ({ resumed: true }),
      defaultSpawnAgent: (argv, opts) => { calls.push(['spawn', argv.slice(0, 3), opts.cwd]); return 'backgrounded'; },
      defaultListAgents: () => [],
    },
  });
  const r = io.resume({ session: { id: 'a287c608', sessionId: sid, kind: 'background', cwd: '/scratch', state: 'working', status: 'idle', pid: 4242 }, prompt: 'x' });
  expect(calls[0]).toEqual(['stop', 'a287c608']); // never the full uuid: `claude stop <uuid>` is "No job matching"
  expect(calls[1]).toEqual(['spawn', ['--bg', '--resume', sid], '/scratch']);
  expect(r).toMatchObject({ resumed: true });
});

// The resume port's fail-closed branches: every refusal must be driven, so dropping a guard line reddens a test.
describe('resume port: stop-before-resume guards', () => {
  const sid = 'a287c608-48e3-4d38-99f1-10496475407f';
  const mk = ({ stop = () => ({ stopped: true }), pidAliveFn, rows = [], onSleep = () => {} } = {}) => {
    const calls = [];
    return {
      calls,
      ioPromise: defaultAwaitVerifyIo({
        sleep: (ms) => { calls.push(['sleep', ms]); onSleep(ms); },
        pidAliveFn,
        stopSessionFn: ({ handle }) => { calls.push(['stop', handle]); return stop({ handle }); },
        dispatchIo: {
          buildAgentArgv: ({ resumeSessionId }) => ['--bg', '--resume', resumeSessionId],
          parseBackgroundedId: () => sid,
          resumeSucceeded: () => ({ resumed: true }),
          defaultSpawnAgent: () => { calls.push(['spawn']); return 'backgrounded'; },
          defaultListAgents: () => (typeof rows === 'function' ? rows() : rows),
        },
      }),
    };
  };
  const idle = { id: 'a287c608', sessionId: sid, kind: 'background', cwd: '/scratch', state: 'working', status: 'idle', pid: 4242 };
  const spawned = (calls) => calls.some((c) => c[0] === 'spawn');
  const stopped = (calls) => calls.some((c) => c[0] === 'stop');

  // The terminal states are the reaper's own AGENT_GONE_STATES: a gone session has no process to stop or wait on, so
  // a row without a usable pid resumes at once instead of being refused forever for not literally reading 'stopped'.
  it.each(['stopped', 'done', 'failed'])('a %s session with no usable pid resumes without a stop or an exit wait', async (state) => {
    const h = mk({ pidAliveFn: () => { throw new Error('pid must not be consulted'); } });
    const { pid: _omit, ...noPid } = idle;
    const r = (await h.ioPromise).resume({ session: { ...noPid, state, status: undefined }, prompt: 'x' });
    expect(r).toMatchObject({ resumed: true });
    expect(stopped(h.calls)).toBe(false);
    expect(h.calls.some((c) => c[0] === 'sleep' && c[1] === 500)).toBe(false);
  });
  it.each(['done', 'failed', 'stopped'])('with an unknown pid, a row that lists %s after the stop counts as exited', async (state) => {
    let listed = 0;
    const live = { ...idle, pid: 0 };
    const h = mk({ rows: () => [{ ...live, state: ++listed <= 1 ? 'working' : state }] });
    const r = (await h.ioPromise).resume({ session: live, prompt: 'x' });
    expect(r).toMatchObject({ resumed: true });
    expect(stopped(h.calls)).toBe(true);
  });
  it('a live (working + idle) background session is stopped before the resume', async () => {
    const h = mk({ pidAliveFn: () => false });
    (await h.ioPromise).resume({ session: idle, prompt: 'x' });
    expect(stopped(h.calls)).toBe(true);
  });
  // Only a row that positively says `kind:'background'` is ever stopped: a missing kind fails closed, on the
  // supplied row AND on the freshly-read one (same strict guard as the session reaper).
  it.each([undefined, '', 'interactive', 'remote'])('never stops a session whose supplied kind is %j', async (kind) => {
    const h = mk({ pidAliveFn: () => false });
    const r = (await h.ioPromise).resume({ session: { ...idle, kind }, prompt: 'x' });
    expect(r.resumed).toBe(false);
    expect(r.reason).toMatch(/not a background dispatch/);
    expect(stopped(h.calls)).toBe(false);
    expect(spawned(h.calls)).toBe(false);
  });
  it.each([undefined, '', 'interactive'])('never stops a background-looking session whose refreshed row has kind %j', async (kind) => {
    const h = mk({ pidAliveFn: () => false, rows: [{ ...idle, kind }] });
    const r = (await h.ioPromise).resume({ session: idle, prompt: 'x' });
    expect(r.resumed).toBe(false);
    expect(r.reason).toMatch(/not a background dispatch/);
    expect(stopped(h.calls)).toBe(false);
    expect(spawned(h.calls)).toBe(false);
  });

  it('waits until the stopped process exits, and spawns only after it has', async () => {
    let alive = 3;
    const h = mk({ pidAliveFn: () => (alive-- > 0) });
    const r = (await h.ioPromise).resume({ session: idle, prompt: 'x' });
    expect(r).toMatchObject({ resumed: true });
    expect(alive).toBeLessThan(0); // liveness was polled until it flipped to dead
    expect(h.calls.filter((c) => c[0] === 'sleep' && c[1] === 500).length).toBeGreaterThanOrEqual(3);
    expect(h.calls.findIndex((c) => c[0] === 'spawn')).toBeGreaterThan(h.calls.findIndex((c) => c[0] === 'stop'));
  });
  it('refuses, and never spawns, while the process stays alive after the wait', async () => {
    const h = mk({ pidAliveFn: () => true });
    const r = (await h.ioPromise).resume({ session: idle, prompt: 'x' });
    expect(r).toEqual({ resumed: false, reason: 'stop-before-resume: process still alive' });
    expect(h.calls.filter((c) => c[0] === 'sleep' && c[1] === 500)).toHaveLength(20);
    expect(spawned(h.calls)).toBe(false);
  });
  it('refuses, and never spawns, when the stop itself throws', async () => {
    const h = mk({ stop: () => { throw new Error('claude stop failed\nsecond line'); }, pidAliveFn: () => false });
    const r = (await h.ioPromise).resume({ session: idle, prompt: 'x' });
    expect(r).toEqual({ resumed: false, reason: 'stop-before-resume: claude stop failed' });
    expect(spawned(h.calls)).toBe(false);
  });
  it('falls back to the first 8 chars of the session uuid when the row carries no short id', async () => {
    const h = mk({ pidAliveFn: () => false });
    const { id: _omit, ...noShortId } = idle;
    (await h.ioPromise).resume({ session: noShortId, prompt: 'x' });
    expect(h.calls.find((c) => c[0] === 'stop')).toEqual(['stop', 'a287c608']);
  });
  it('does not kill a session that started a new turn after the pass saw it idle', async () => {
    const h = mk({ pidAliveFn: () => false, rows: [{ ...idle, status: 'busy' }] });
    const r = (await h.ioPromise).resume({ session: idle, prompt: 'x' });
    expect(r).toEqual({ resumed: false, reason: 'stop-before-resume: session started a new turn' });
    expect(h.calls.some((c) => c[0] === 'stop')).toBe(false);
    expect(spawned(h.calls)).toBe(false);
  });
  it('with an unknown pid, exit is read from the session list, not assumed after a sleep', async () => {
    let listed = 0;
    const live = { ...idle, pid: 0 };
    const h = mk({ pidAliveFn: () => { throw new Error('pid must not be consulted'); },
      // 1st read is the pre-stop idle check; then two reads still live; then the row is stopped.
      rows: () => [{ ...live, state: ++listed <= 3 ? 'working' : 'stopped' }] });
    const r = (await h.ioPromise).resume({ session: live, prompt: 'x' });
    expect(r).toMatchObject({ resumed: true });
    expect(listed).toBeGreaterThan(3);
    expect(h.calls.findIndex((c) => c[0] === 'spawn')).toBeGreaterThan(h.calls.findIndex((c) => c[0] === 'stop'));
  });
  it('with an unknown pid, refuses and never spawns while the list still shows the session live', async () => {
    const live = { ...idle, pid: 0 };
    const h = mk({ rows: [{ ...live, state: 'working' }] });
    const r = (await h.ioPromise).resume({ session: live, prompt: 'x' });
    expect(r).toEqual({ resumed: false, reason: 'stop-before-resume: process still alive' });
    expect(spawned(h.calls)).toBe(false);
  });
  it('with an unknown pid, a row missing from the list is "unknown", never "exited": refuses, no spawn', async () => {
    const h = mk({ rows: [] });
    const r = (await h.ioPromise).resume({ session: { ...idle, pid: 0 }, prompt: 'x' });
    expect(r).toEqual({ resumed: false, reason: 'stop-before-resume: process still alive' });
    expect(spawned(h.calls)).toBe(false);
  });
  it('with an unknown pid, a list that stops being readable after the stop never reads as exited', async () => {
    let reads = 0;
    const h = mk({ rows: () => { if (++reads > 1) throw new Error('claude agents timed out'); return []; } });
    const r = (await h.ioPromise).resume({ session: { ...idle, pid: 0 }, prompt: 'x' });
    expect(r).toEqual({ resumed: false, reason: 'stop-before-resume: process still alive' });
    expect(spawned(h.calls)).toBe(false);
  });
  it('refuses, without stopping anything, when the session list cannot be read before the stop', async () => {
    const h = mk({ pidAliveFn: () => false, rows: () => { throw new Error('claude agents timed out'); } });
    const r = (await h.ioPromise).resume({ session: idle, prompt: 'x' });
    expect(r).toEqual({ resumed: false, reason: 'stop-before-resume: session list unreadable' });
    expect(h.calls.some((c) => c[0] === 'stop')).toBe(false);
    expect(spawned(h.calls)).toBe(false);
  });
  it('never stops an operator\'s interactive terminal session', async () => {
    const h = mk({ pidAliveFn: () => false });
    const r = (await h.ioPromise).resume({ session: { ...idle, kind: 'interactive' }, prompt: 'x' });
    expect(r.resumed).toBe(false);
    expect(r.reason).toMatch(/interactive session is not a background dispatch/);
    expect(h.calls.some((c) => c[0] === 'stop')).toBe(false);
    expect(spawned(h.calls)).toBe(false);
  });
  it('reads the live row UNCACHED: the 20s agents cache would return the row the pass already judged', async () => {
    const seen = [];
    const calls = [];
    const io = await defaultAwaitVerifyIo({
      sleep: () => {}, pidAliveFn: () => false, env: { WE_CLAUDE_AGENTS_CACHE_TTL_MS: '20000' },
      stopSessionFn: () => ({ stopped: true }),
      dispatchIo: {
        buildAgentArgv: () => [], parseBackgroundedId: () => sid, resumeSucceeded: () => ({ resumed: true }),
        defaultSpawnAgent: () => 'x',
        defaultListAgents: ({ env }) => { seen.push(env.WE_CLAUDE_AGENTS_CACHE_TTL_MS); calls.push(1); return [{ ...idle }]; },
      },
    });
    io.resume({ session: idle, prompt: 'x' });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((ttl) => ttl === '0')).toBe(true); // the pre-stop read AND the post-spawn confirmation reads
    expect(seen.length).toBeGreaterThanOrEqual(2);
  });
});
