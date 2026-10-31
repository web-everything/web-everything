import { describe, it, expect } from 'vitest';
import { runAwaitVerifyPass, defaultAwaitVerifyIo } from '../await-verify-pass.mjs';
import ciBreak from '../soak/breaks/claude-fix-push-after-ci.mjs';

const SHA = 'a'.repeat(40);
const PREVIOUS = 'b'.repeat(40);
const T0 = Date.parse('2026-10-29T12:00:00Z');

function harness({ early = true, enabled = true } = {}) {
  let record = { v: 1, kind: 'fix', pr: 6085, repo: 'web-everything/web-everything',
    sha: SHA, sessionId: 'claude-fix', who: 'fix-6085', lane: '/lanes/lane-49',
    ref: 'lane/ci-parallel-settings', requestedAt: new Date(T0).toISOString(), attempt: 1 };
  const state = { status: 'running', checks: [{ name: 'test', status: 'in_progress' }],
    required: ['test'], pushes: [], reads: [], writes: true, head: PREVIOUS, resumes: [] };
  const io = {
    pushPolicy: () => ({ pushBeforeGate: early }),
    fixTimingPolicy: () => ({ pushAfterCi: enabled, pushAfterCiMaxMin: 2 }),
    readPreviousHead: args => { state.reads.push(args); return state.head; },
    readPreviousChecks: args => { state.reads.push(args); return state.checks; },
    readPreviousRequired: () => ({ checks: state.required }),
    listRecords: () => record ? [{ key: 'claude-fix', record }] : [],
    writeRecord: next => { if (!state.writes) return { ok: false }; record = next; return { ok: true }; },
    clearRecord: () => { record = null; },
    laneState: () => ({ head: SHA, dirty: false, treeHash: 'tree' }),
    readMarker: () => ({ sha: SHA, status: state.status, startedAt: new Date(T0).toISOString(), treeHash: 'tree' }),
    listSessions: () => [{ sessionId: 'claude-fix', state: 'done' }],
    push: args => { state.pushes.push(args); return { ok: true }; },
    resume: args => { state.resumes.push(args); return { resumed: true }; },
    rerequest: () => ({ ok: true }),
  };
  return { io, state, record: () => record,
    tick: (elapsed = 0, extra = {}) => runAwaitVerifyPass({ io, nowMs: T0 + elapsed, loggedPolicyLine: { value: null }, ...extra }) };
}

describe('Claude verify harness honors fix.pushAfterCi', () => {
  it.each([true, false])('holds the previous head CI with pushBeforeGate=%s, then pushes on completion', async early => {
    const h = harness({ early });
    if (!early) h.state.status = 'green';
    await h.tick();
    expect(h.state.pushes).toHaveLength(0);
    expect(h.state.resumes).toHaveLength(0);
    expect(h.record().previousCi.headSha).toBe(PREVIOUS);
    h.state.checks = [{ name: 'test', status: 'completed', conclusion: 'success' }];
    await h.tick(30_000);
    expect(h.state.pushes).toHaveLength(1);
    expect(h.state.reads).toContainEqual({ repo: 'web-everything/web-everything', headSha: PREVIOUS });
  });

  it.each(['head', 'checks', 'required', 'missing'])('holds unreadable %s evidence until the persisted bound, across a rerequest/restart', async failure => {
    const h = harness();
    if (failure === 'head') h.io.readPreviousHead = () => { throw new Error('offline'); };
    if (failure === 'checks') h.io.readPreviousChecks = () => { throw new Error('offline'); };
    if (failure === 'required') h.io.readPreviousRequired = () => { throw new Error('offline'); };
    if (failure === 'missing') h.state.checks = [];
    await h.tick();
    expect(h.state.pushes).toHaveLength(0);
    // Simulate the verify retry updating requestedAt, and a new daemon pass using persisted state.
    h.io.writeRecord({ ...h.record(), requestedAt: new Date(T0 + 60_000).toISOString() });
    await h.tick(119_999);
    expect(h.state.pushes).toHaveLength(0);
    const result = await h.tick(120_000);
    expect(h.state.pushes).toHaveLength(1);
    expect(JSON.stringify(result.rows)).toContain('bound');
  });

  it('pins the previous head and accepts completed legacy statuses and failed required CI', async () => {
    const h = harness();
    await h.tick();
    expect(h.state.pushes).toHaveLength(0);
    expect(h.record().previousCi.headSha).toBe(PREVIOUS);
    h.state.head = 'c'.repeat(40);
    h.state.checks = [{ context: 'test', state: 'failure' }];
    await h.tick(30_000);
    expect(h.state.pushes).toHaveLength(1);
    expect(h.state.reads.filter(args => args.headSha).every(args => args.headSha === PREVIOUS)).toBe(true);
    expect(h.record().previousCi.ready.ciFailures).toContainEqual(expect.objectContaining({ name: 'test' }));
  });

  it('never pushes if the wait state cannot be persisted', async () => {
    const h = harness();
    h.state.writes = false;
    h.state.checks = [{ name: 'test', conclusion: 'success', status: 'completed' }];
    await h.tick();
    expect(h.state.pushes).toHaveLength(0);
  });

  it('polls at most every thirty seconds without blocking a local verify rerequest', async () => {
    const h = harness();
    await h.tick();
    const reads = h.state.reads.length;
    h.io.readMarker = () => null;
    let requested = 0;
    h.io.rerequest = () => { requested++; return { ok: true }; };
    await h.tick(10_000);
    expect(h.state.reads).toHaveLength(reads);
    expect(requested).toBe(1);
    expect(h.state.pushes).toHaveLength(0);
  });

  it('delivers local verify red immediately while previous CI remains pending', async () => {
    const h = harness();
    await h.tick();
    h.state.status = 'red';
    await h.tick(10_000);
    expect(h.state.pushes).toHaveLength(0);
    expect(h.state.resumes).toHaveLength(1);
    expect(h.state.resumes[0].prompt).toContain('RED');
  });

  it.each([true, false])('does not push a local red that arrives during CI reads (early=%s)', async early => {
    const h = harness({ early });
    if (!early) h.state.status = 'green';
    h.io.readPreviousChecks = () => {
      h.state.status = 'red';
      return [{ name: 'test', status: 'completed', conclusion: 'success' }];
    };
    await h.tick();
    expect(h.state.pushes).toHaveLength(0);
    expect(h.state.resumes).toHaveLength(1);
    expect(h.state.resumes[0].prompt).toContain('RED');
  });

  it('does no timing reads for a CI heal wait', async () => {
    const h = harness();
    h.io.writeRecord({ ...h.record(), kind: 'ci-heal' });
    h.state.status = 'green';
    await h.tick();
    expect(h.state.pushes).toHaveLength(1);
    expect(h.state.reads).toHaveLength(0);
  });

  it('preserves immediate pushes when the setting is off', async () => {
    const h = harness({ enabled: false });
    await h.tick();
    expect(h.state.pushes).toHaveLength(1);
    expect(h.state.reads).toHaveLength(0);
  });

  it('does not wait for this fix CI after an early push already succeeded', async () => {
    const h = harness();
    h.state.checks = [{ name: 'test', status: 'completed', conclusion: 'success' }];
    await h.tick();
    expect(h.state.pushes).toHaveLength(1);
    h.state.status = 'green';
    h.io.readPreviousChecks = () => { throw new Error('must not re-read'); };
    await h.tick(30_000);
    expect(h.state.resumes).toHaveLength(1);
  });

  it('loads the timing cascade on the production IO with environment provenance', async () => {
    const io = await defaultAwaitVerifyIo({ env: { WE_FIX_PUSH_AFTER_CI: 'true', WE_FIX_PUSH_AFTER_CI_MAX_MIN: '3' },
      dispatchIo: {}, stopSessionFn: () => {}, pushRefusalFn: () => null, readClaimFn: () => null });
    expect(io.fixTimingPolicy()).toMatchObject({ pushAfterCi: true, pushAfterCiMaxMin: 3,
      sources: { pushAfterCi: 'env', pushAfterCiMaxMin: 'env' } });
  });

  it('replays the supported Claude path as a daemon soak break', async () => {
    expect(ciBreak.judge(await ciBreak.run())).toEqual([]);
  });
});
