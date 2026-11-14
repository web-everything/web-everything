import { describe, it, expect } from 'vitest';
import { runAwaitVerifyPass, buildAwaitVerifyResumePrompt } from '../await-verify-pass.mjs';

const SHA = 'e'.repeat(40);
const OTHER = 'd'.repeat(40);
const T0 = Date.parse('2026-11-14T22:44:00Z');
const RUN = '43632493009';
const redRow = (over = {}) => ({ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE',
  detailsUrl: `https://github.com/web-everything/web-everything/actions/runs/${RUN}/job/1`, ...over });

function harness({ checks, prHead = SHA, laneHead = SHA, infraFallback = true, record: extra = {} } = {}) {
  let record = { v: 1, kind: 'fix', pr: 6770, repo: 'web-everything/web-everything', sha: SHA, sessionId: 'claude-fix',
    who: 'fix-6770', lane: '/lanes/lane-9', ref: 'lane/x', requestedAt: new Date(T0 - 60_000).toISOString(), attempt: 1,
    retries: 2, lastRetry: 'infrastructure-failure', ...extra };
  const s = { resumes: [], rerequests: 0, cleared: 0, checks, prHead };
  const io = {
    listRecords: () => (record ? [{ key: 'claude-fix', record }] : []),
    writeRecord: next => { record = next; return { ok: true }; },
    clearRecord: () => { s.cleared++; record = null; return { cleared: true }; },
    laneState: () => ({ head: laneHead, dirty: false, treeHash: 't' }),
    readMarker: () => ({ sha: laneHead, status: 'infrastructure-failure', startedAt: new Date(T0 - 1000).toISOString(),
      infrastructure: { reason: 'verify-unsettled', detail: 'x' } }),
    listSessions: () => [{ sessionId: 'claude-fix', state: 'done' }],
    resume: a => { s.resumes.push(a); return { resumed: true }; },
    rerequest: () => { s.rerequests++; return { ok: true }; },
    readPreviousHead: () => s.prHead,
    readPreviousChecks: () => s.checks,
    readPreviousRequired: () => ({ source: 'live', checks: ['test'] }),
    infraFallbackToCi: () => ({ enabled: infraFallback, source: 'standard' }),
  };
  return { s, io, rec: () => record, tick: (ms = 0) => runAwaitVerifyPass({ io, nowMs: T0 + ms, loggedPolicyLine: { value: null } }) };
}

describe('infra-failure + real red CI on the same head resumes the fixer with the CI evidence', () => {
  it('resumes with failing job names + run id, never re-requests verify, and is not repeated', async () => {
    const h = harness({ checks: [redRow(), redRow({ name: 'lint', conclusion: 'SUCCESS' }), redRow({ name: 'import-graph' })] });
    const { rows } = await h.tick();
    expect(h.s.rerequests).toBe(0);
    expect(h.s.resumes).toHaveLength(1);
    const prompt = h.s.resumes[0].prompt;
    expect(prompt).toContain(RUN);
    expect(prompt).toContain('import-graph');
    expect(prompt).toContain(SHA);
    expect(rows[0].result).toMatch(/resumed:ci-red/);
    await h.tick(120_000); // record cleared: no second resume, no verify request
    expect(h.s.resumes).toHaveLength(1);
    expect(h.s.rerequests).toBe(0);
  });
  it('a busy session retries the same delivery once (keyed to sha+run), never a verify request', async () => {
    const h = harness({ checks: [redRow()] });
    h.io.listSessions = () => [{ sessionId: 'claude-fix', state: 'busy', busy: true }];
    await h.tick();
    expect(h.s.rerequests).toBe(0);
    expect(h.rec().pendingResume.ciRed).toEqual({ sha: SHA, runId: RUN, failures: ['test'] });
  });
  it('a cancelled / timed_out / startup_failure required check is infra noise, not a real red', async () => {
    for (const conclusion of ['CANCELLED', 'TIMED_OUT', 'STARTUP_FAILURE']) {
      const h = harness({ checks: [redRow({ conclusion })] });
      await h.tick();
      expect(h.s.resumes, conclusion).toHaveLength(0);
      expect(h.s.rerequests, conclusion).toBe(1);
    }
  });
  it('unreadable run id fails closed (retry ladder stands)', async () => {
    const h = harness({ checks: [redRow({ detailsUrl: 'https://example.com/x' })] });
    await h.tick();
    expect(h.s.resumes).toHaveLength(0);
    expect(h.s.rerequests).toBe(1);
  });
});

describe('unchanged neighbours', () => {
  it('CI pending: retry as before', async () => {
    const h = harness({ checks: [{ name: 'test', status: 'IN_PROGRESS' }] });
    await h.tick();
    expect(h.s.resumes).toHaveLength(0);
    expect(h.s.rerequests).toBe(1);
  });
  it('CI red on a DIFFERENT head (PR head moved): unchanged', async () => {
    const h = harness({ checks: [redRow()], prHead: OTHER });
    await h.tick();
    expect(h.s.resumes).toHaveLength(0);
    expect(h.s.rerequests).toBe(1);
  });
  it('lane head differs from the record sha: unchanged', async () => {
    const h = harness({ checks: [redRow()], laneHead: OTHER });
    await h.tick();
    expect(h.s.resumes.filter(r => /Previous|CI is RED/.test(r.prompt))).toHaveLength(0);
  });
  it('infra + CI green fallback (retries spent, early push) still pushes-as-handed-back, not a CI-red resume', async () => {
    const green = { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' };
    const h = harness({ checks: [green], record: { earlyPush: { ok: true, sha: SHA, upToDate: true, attempts: 1 }, infraRetry: { exhausted: true } } });
    h.io.readMarker = () => ({ sha: SHA, status: 'infrastructure-failure', startedAt: new Date(T0 - 1000).toISOString(),
      infrastructure: { reason: 'verify-timeout', detail: 'x' } });
    const { rows } = await h.tick();
    expect(rows[0].reason).toMatch(/infra-ci-green-fallback/);
    expect(h.s.resumes.every(r => !/ci-red|CI is RED/.test(r.prompt))).toBe(true);
  });
});

describe('prompt', () => {
  it('names the failing jobs and run, fenced as data', () => {
    const p = buildAwaitVerifyResumePrompt({ kind: 'ci-red', record: { pr: 6770, repo: 'r', sha: SHA, attempt: 1, ref: 'lane/x', kind: 'fix', pendingResume: { ciRed: { sha: SHA, runId: RUN, failures: ['test'] } } } });
    expect(p).toContain(RUN);
    expect(p).toContain('test');
  });
});
