import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { scanText as scanPrivacyText } from '../privacy-terms.mjs';
import { approvalCheckPayload, evaluateApprovalRecord, readApprovalRecord, writeApprovalRecord, APPROVAL_CHECK_NAME, PINNED_APP_ID_SHA256, OPERATOR_LOGINS } from '../approval-record.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const APP = JSON.parse(readFileSync(new URL('../../settings/red-team.json', import.meta.url), 'utf8')).redTeamGate.appId;
const OTHER_APP = APP + 1;
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
  it('a caller-set WE_APP_ID cannot choose the trusted app, and the read bypasses the memo', () => {
    const forged = run({ app: { id: OTHER_APP } });
    const gh = vi.fn(() => JSON.stringify({ total_count: 1, check_runs: [forged] }));
    const seen = [];
    const resolveApp = ({ env }) => { seen.push(env.WE_APP_ID); return { ok: true, appId: String(APP) }; };
    const r = readApprovalRecord({ repo: 'o/r', headSha: A, gh, resolveApp, env: { WE_APP_ID: String(OTHER_APP) } });
    expect(seen).toEqual([undefined]);
    expect(r.ok).toBe(false);
    expect(gh.mock.calls[0][1].throttle.noMemo).toBe(true);
  });
  it('the trusted App is pinned in code: a settings or caller app id that differs refuses', () => {
    const forged = run({ app: { id: OTHER_APP } });
    const gh = vi.fn(() => JSON.stringify({ total_count: 1, check_runs: [forged] }));
    expect(readApprovalRecord({ repo: 'o/r', headSha: A, gh, resolveApp: () => ({ ok: true, appId: String(OTHER_APP) }) }).ok).toBe(false);
    expect(readApprovalRecord({ repo: 'o/r', headSha: A, gh, appId: OTHER_APP }).ok).toBe(false);
    expect(gh).not.toHaveBeenCalled();
  });
  it('an unreadable setting cannot widen or disable the pin: the pinned App still decides', () => {
    const gh = () => JSON.stringify({ total_count: 1, check_runs: [run()] });
    expect(readApprovalRecord({ repo: 'o/r', headSha: A, gh, resolveApp: () => ({ ok: false, reason: 'unset' }) }).ok).toBe(true);
    expect(readApprovalRecord({ repo: 'o/r', headSha: A, gh, resolveApp: () => { throw new Error('unreadable'); } }).ok).toBe(true);
    expect(createHash('sha256').update(String(APP)).digest('hex')).toBe(PINNED_APP_ID_SHA256);
  });
  it('only the pinned App can supply the evaluator identity when settings are unreadable', () => {
    const gh = vi.fn(() => JSON.stringify({ total_count: 1, check_runs: [run({ app: { id: OTHER_APP } })] }));
    expect(readApprovalRecord({ repo: 'o/r', headSha: A, gh, resolveApp: () => ({ ok: false }) }).ok).toBe(false);
    gh.mockReturnValue(JSON.stringify({ total_count: 2, check_runs: [run({ id: 99, app: { id: OTHER_APP } }), run()] }));
    expect(readApprovalRecord({ repo: 'o/r', headSha: A, gh, resolveApp: () => ({ ok: false }) }).ok).toBe(true);
  });
  it('keeps operational account identifiers out of approval source and fixtures (R972)', () => {
    for (const url of [new URL('../approval-record.mjs', import.meta.url), new URL(import.meta.url)]) {
      expect(scanPrivacyText(readFileSync(url)).filter(hit => hit.pattern === 'account-id')).toEqual([]);
    }
  });
  it('a head that moved between read and land refuses', () => {
    const gh = () => JSON.stringify({ total_count: 1, check_runs: [run()] });
    expect(readApprovalRecord({ repo: 'o/r', headSha: A, appId: APP, gh, recheckHead: () => B }).ok).toBe(false);
    expect(readApprovalRecord({ repo: 'o/r', headSha: A, appId: APP, gh, recheckHead: () => A }).ok).toBe(true);
  });
});

describe('writeApprovalRecord', () => {
  const base = { repo: 'o/r', headSha: A, rulingId: 'R474', approver: 'chalbert', rulingExists: () => true };
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
  it('a login outside the pinned operator allowlist writes nothing', () => {
    const gh = vi.fn();
    for (const approver of ['someone-else', 'chalbert-x', 'xchalbert', 'op']) expect(writeApprovalRecord({ ...base, approver, gh }).ok).toBe(false);
    expect(gh).not.toHaveBeenCalled();
    expect(OPERATOR_LOGINS).toEqual(['chalbert']);
  });
  it('a missing approver identity writes nothing', () => {
    const gh = vi.fn();
    for (const approver of [undefined, '', 'unknown']) expect(writeApprovalRecord({ ...base, approver, gh }).ok).toBe(false);
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
    expect(payload).toEqual(approvalCheckPayload({ headSha: A, rulingId: 'R474', approver: 'chalbert' }));
    expect(post[1].env.WE_GH_AUTH_PERSONAL_FALLBACK).toBe('refuse');
  });
});
