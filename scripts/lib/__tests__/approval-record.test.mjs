import { describe, it, expect, vi } from 'vitest';
import { approvalCheckPayload, evaluateApprovalRecord, readApprovalRecord, writeApprovalRecord, APPROVAL_CHECK_NAME } from '../approval-record.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const APP = 5037855;
const run = (over = {}) => ({ id: 10, name: APPROVAL_CHECK_NAME, head_sha: A, external_id: `R474@${A}`, app: { id: APP },
  status: 'completed', conclusion: 'success', ...over });
const ev = (checkRuns, headSha = A) => evaluateApprovalRecord({ headSha, checkRuns, appId: APP });

describe('evaluateApprovalRecord (negative tests first)', () => {
  it('record for head A does not approve head B', () => {
    expect(ev([run()], B).ok).toBe(false);
    expect(ev([run({ head_sha: B })], A).ok).toBe(false);
  });
  it('record written by another login (other app id) is refused, even with the same name', () => {
    expect(ev([run({ app: { id: 999 } })]).ok).toBe(false);
    expect(ev([run({ app: undefined })]).ok).toBe(false);
  });
  it('a missing record refuses', () => {
    expect(ev([]).ok).toBe(false);
    expect(ev(null).ok).toBe(false);
  });
  it('a short or other head in the record or the query refuses', () => {
    expect(ev([run({ external_id: 'R474@aaaaaaa' })]).ok).toBe(false);
    expect(ev([run({ external_id: `R474@${B}` })]).ok).toBe(false);
    expect(ev([run()], 'aaaaaaa').ok).toBe(false);
  });
  it('a record without a ruling id, or a malformed one, refuses', () => {
    expect(ev([run({ external_id: `@${A}` })]).ok).toBe(false);
    expect(ev([run({ external_id: `Rx@${A}` })]).ok).toBe(false);
    expect(ev([run({ external_id: 'garbage' })]).ok).toBe(false);
    expect(ev([run({ external_id: undefined })]).ok).toBe(false);
  });
  it('the newest id wins, even when timestamps tie', () => {
    const ok = run({ id: 5, started_at: 'x', completed_at: 'x' });
    const revoked = run({ id: 6, conclusion: 'failure', started_at: 'x', completed_at: 'x' });
    expect(ev([ok, revoked]).ok).toBe(false);
    expect(ev([revoked, ok]).ok).toBe(false);
    expect(ev([run({ id: 7 }), revoked]).ok).toBe(true);
  });
  it('unordered or duplicate ids refuse', () => {
    expect(ev([run({ id: 3 }), run({ id: 3 })]).ok).toBe(false);
    expect(ev([run({ id: 'x' })]).ok).toBe(false);
  });
  it('an in-progress or failed record refuses', () => {
    expect(ev([run({ status: 'in_progress', conclusion: null })]).ok).toBe(false);
    expect(ev([run({ conclusion: 'failure' })]).ok).toBe(false);
  });
  it('a missing app id refuses', () => {
    expect(evaluateApprovalRecord({ headSha: A, checkRuns: [run()] }).ok).toBe(false);
  });
  it('a valid record approves and names the ruling', () => {
    expect(ev([run({ external_id: `R474+R475@${A}` })])).toMatchObject({ ok: true, rulingId: 'R474+R475' });
  });
});

describe('readApprovalRecord', () => {
  it('a gh failure or malformed payload refuses (never fail-open)', () => {
    expect(readApprovalRecord({ repo: 'o/r', headSha: A, appId: APP, gh: () => { throw new Error('boom'); } }).ok).toBe(false);
    expect(readApprovalRecord({ repo: 'o/r', headSha: A, appId: APP, gh: () => 'not json' }).ok).toBe(false);
    expect(readApprovalRecord({ repo: 'o/r', headSha: A, appId: APP, gh: () => '{}' }).ok).toBe(false);
  });
  it('reads check runs for exactly the head', () => {
    const gh = vi.fn(() => JSON.stringify({ total_count: 1, check_runs: [run()] }));
    expect(readApprovalRecord({ repo: 'o/r', headSha: A, appId: APP, gh }).ok).toBe(true);
    expect(gh.mock.calls[0][0].join(' ')).toContain(`commits/${A}/check-runs`);
  });
  it('a head that moved between read and land refuses', () => {
    const gh = () => JSON.stringify({ total_count: 1, check_runs: [run()] });
    expect(readApprovalRecord({ repo: 'o/r', headSha: A, appId: APP, gh, recheckHead: () => B }).ok).toBe(false);
    expect(readApprovalRecord({ repo: 'o/r', headSha: A, appId: APP, gh, recheckHead: () => A }).ok).toBe(true);
  });
});

describe('writeApprovalRecord', () => {
  const base = { repo: 'o/r', headSha: A, rulingId: 'R474', approver: 'op', rulingExists: () => true };
  it('an unknown ruling id writes nothing', () => {
    const gh = vi.fn();
    expect(writeApprovalRecord({ ...base, rulingExists: () => false, gh }).ok).toBe(false);
    expect(gh).not.toHaveBeenCalled();
  });
  it('a bad ruling id or short head writes nothing', () => {
    const gh = vi.fn();
    expect(writeApprovalRecord({ ...base, rulingId: 'nope', gh }).ok).toBe(false);
    expect(writeApprovalRecord({ ...base, headSha: 'abc', gh }).ok).toBe(false);
    expect(gh).not.toHaveBeenCalled();
  });
  it('a missing App token (probe fails) writes nothing', () => {
    const gh = vi.fn(() => { throw new Error('403'); });
    expect(writeApprovalRecord({ ...base, gh }).ok).toBe(false);
    expect(gh.mock.calls.every(c => !c[0].includes('POST'))).toBe(true);
  });
  it('posts the head-bound payload as the App writer', () => {
    const gh = vi.fn(() => '1');
    expect(writeApprovalRecord({ ...base, gh }).ok).toBe(true);
    const post = gh.mock.calls.find(c => c[0].includes('POST'));
    const payload = JSON.parse(post[1].input);
    expect(payload).toMatchObject({ name: APPROVAL_CHECK_NAME, head_sha: A, external_id: `R474@${A}`, conclusion: 'success' });
    expect(payload).toEqual(approvalCheckPayload({ headSha: A, rulingId: 'R474', approver: 'op' }));
    expect(post[1].env.WE_GH_AUTH_PERSONAL_FALLBACK).toBe('refuse');
  });
});
