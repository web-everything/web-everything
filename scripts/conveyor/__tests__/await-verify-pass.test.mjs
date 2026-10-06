import { describe, it, expect } from 'vitest';
import {
  classifyAwaitVerdict, isLoadFlakeRed, runAwaitVerifyPass, buildAwaitVerifyResumePrompt, findAwaitSession,
  formatAwaitVerifyLines, isHarnessRecord, AWAIT_VERIFY_LIMITS,
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
    const h = harness({ pushResult: { ok: false, reason: '! [rejected] (non-fast-forward)' } });
    h.state.marker = marker('green');
    await runAwaitVerifyPass({ io: h.io, nowMs: T0 + 60_000, ttlMs: TTL });
    expect(h.calls.resume[0].prompt).toMatch(/could NOT push/);
    const t = harness({ pushResult: { ok: false, transient: true, reason: 'Could not resolve host' } });
    t.state.marker = marker('green');
    const { rows } = await runAwaitVerifyPass({ io: t.io, nowMs: T0 + 60_000, ttlMs: TTL });
    expect(rows[0].result).toMatch(/^push-retry/);
    expect(t.calls.resume).toEqual([]);
    expect([...t.store.values()][0].retries).toBe(1);
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
  it('a vanished session after a green push drops the record (the push already happened)', async () => {
    const h = harness({ session: null });
    h.state.marker = marker('green');
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
