import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { newRunRecord, readRun, writeRun, runPath } from '../../operations/run-store.mjs';
import { findSuspendedReferralRuns, planReferralExpiry, expireSuspendedReferralRun, expireStuckReferralRuns } from '../stuck-referral-expiry.mjs';
import { readDrainRedTeamEvidence, ABANDONED_REVIEW_AFTER_MS } from '../drain-red-team-evidence.mjs';
import { resolveReviewRedTeamOnSkip, runRedTeamOnSkip } from '../review-red-team-on-skip.mjs';
import { needsJudgment } from '../../operations/judge-sweep-facts.mjs';
import { createJudgeSweepFactsReader } from '../../operations/judge-sweep-facts-io.mjs';
const repo = 'o/r', pr = 1, head = 'a'.repeat(40), now = Date.now(), hour = 3600000, deadlineMs = 4 * hour;
const dirs = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function fixture(age = 5 * hour, extra = {}) {
  const runsDir = mkdtempSync(join(tmpdir(), 'referral-expiry-')); dirs.push(runsDir);
  const run = Object.assign(newRunRecord({ id: 'review-pr-stuck', op: 'review-pr', input: { repo, pr } }), {
    findings: { read: { repo, pr, netBasis: { rev: head } } },
    stepTimings: [{ step: 'read', stepIndex: 0, startedAt: new Date(now - age).toISOString() }],
    pending: { kind: 'effect', step: 'mandatoryReferrals', stepIndex: 8, count: 1 },
    effects: ['pending', 'in-flight'].map((status, index) => ({ key: `effect-${index}`, type: 'review.mandatory-referrals', stepIndex: 1, index, status })), ...extra });
  writeRun(run, runsDir); utimesSync(runPath(run.id, runsDir), (now - age) / 1000, (now - age) / 1000);
  return { runsDir, runId: run.id, repo, pr, head, now, deadlineMs };
}
const bytes = f => readFileSync(runPath(f.runId, f.runsDir), 'utf8');
describe('stuck referral expiry', () => {
  it('expires without a verdict or acceptance and the real drain abandons it after its horizon', () => {
    const f = fixture();
    const evidence = at => readDrainRedTeamEvidence({ ...f, now: at, readScorecards: () => [], env: { OPERATION_RUNS_DIR: f.runsDir, WE_SHARED_RUNS_DIR: join(f.runsDir, 'shared', 'runs') } });
    expect(evidence(now)).toMatchObject({ ok: false, reason: 'review-unfinished' });
    expect(expireSuspendedReferralRun(f)).toEqual({ expired: true, runId: f.runId, deadlineMs });
    const run = readRun(f.runId, f.runsDir);
    expect(run.pending).toBeNull(); expect(run.verdict).toBeNull();
    expect(run.expired).toMatchObject({ reason: expect.stringContaining('no referral ruling'), deadlineMs });
    expect(run.effects.every(e => e.status === 'failed' && e.error.startsWith('expired: no referral ruling within'))).toBe(true);
    expect(evidence(Date.now() + ABANDONED_REVIEW_AFTER_MS + 5000).reason).not.toBe('review-unfinished');
  });
  it('planner only expires or holds, never clears or accepts', () => {
    const f = fixture(), run = findSuspendedReferralRuns(f)[0];
    expect(planReferralExpiry(run, { now, deadlineMs, live: false }).action).toBe('expire');
    expect(planReferralExpiry(run, { now, deadlineMs, live: true }).action).toBe('hold');
  });
  it('holds young runs byte-identically', () => {
    const f = fixture(hour), before = bytes(f);
    expect(expireSuspendedReferralRun(f).expired).toBe(false); expect(bytes(f)).toBe(before);
  });
  it('holds a proven live pid even when old', () => {
    const f = fixture(5 * hour, { host: 'host', pidNamespace: 'ns', pid: 123 }), before = bytes(f);
    expect(expireSuspendedReferralRun({ ...f, probe: { host: 'host', namespace: 'ns', isAlive: () => true } }).expired).toBe(false);
    expect(bytes(f)).toBe(before);
  });
  it('holds recent ruling work for this run', () => {
    const f = fixture(), before = bytes(f);
    const ruling = newRunRecord({ id: 'ruling-new', op: 'record-referral-ruling', input: { repo, pr } });
    ruling.verdict = { record: { rulings: [{ runId: f.runId }] } }; writeRun(ruling, f.runsDir);
    expect(expireSuspendedReferralRun(f).expired).toBe(false); expect(bytes(f)).toBe(before);
  });
  it('fails closed on unreadable evidence and oversized scans', () => {
    expect(() => findSuspendedReferralRuns({ repo, pr, list: () => ['bad'], read: () => { throw Error('unreadable'); } })).toThrow();
    expect(() => findSuspendedReferralRuns({ repo, pr, list: () => Array(10001).fill('id') })).toThrow();
    expect(planReferralExpiry({}, { now, deadlineMs, live: null })).toMatchObject({ action: 'hold' });
  });
  it.each([{ resumedAt: new Date(now - hour).toISOString() }, { resumeOf: 'prior' }])('holds recent or unknown resumes %j', extra => {
    const f = fixture(5 * hour, extra); expect(expireSuspendedReferralRun(f).expired).toBe(false);
  });
  it('holds a live session and a present verdict without changing bytes', () => {
    const f = fixture(5 * hour, { sessionId: 'session' }), before = bytes(f);
    expect(expireSuspendedReferralRun({ ...f, probe: { isSessionAlive: () => true } }).expired).toBe(false);
    expect(bytes(f)).toBe(before);
    const decided = fixture(5 * hour, { verdict: { verdict: 'changes' } }), decidedBefore = bytes(decided);
    expect(expireSuspendedReferralRun(decided).expired).toBe(false); expect(bytes(decided)).toBe(decidedBefore);
  });
  it('uses the quiet deadline for an unprobeable owner and holds recent writes', () => {
    const f = fixture(5 * hour, { host: 'elsewhere', pid: 123 });
    expect(expireSuspendedReferralRun({ ...f, probe: { host: 'local' } }).expired).toBe(true);
    const recent = fixture(1000), before = bytes(recent);
    expect(expireSuspendedReferralRun(recent).expired).toBe(false); expect(bytes(recent)).toBe(before);
  });
  it('holds unreadable evidence without writing', () => {
    const f = fixture(), write = vi.fn();
    expect(expireSuspendedReferralRun({ ...f, read: () => { throw Error('unreadable'); }, write }).expired).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
  it('rechecks changed evidence before writing', () => {
    const f = fixture(), write = vi.fn(); let reads = 0;
    const read = (id, dir) => { const run = readRun(id, dir); if (++reads > 1) run.pending = null; return run; };
    expect(expireSuspendedReferralRun({ ...f, read, write }).expired).toBe(false); expect(write).not.toHaveBeenCalled();
  });
  it('logs the expiry deadline and setting source; zero disables all IO', () => {
    const f = fixture(), log = vi.fn();
    expect(expireStuckReferralRuns({ ...f, setting: { value: { referralRunExpiryHours: 4 }, sources: { referralRunExpiryHours: 'tool' } }, log }).expired).toBe(true);
    expect(log).toHaveBeenCalledWith(`stuck-referral-expiry: ${repo}#${pr} run=${f.runId} expired deadline=4h source=tool`);
    const list = vi.fn(); expireStuckReferralRuns({ ...f, setting: { referralRunExpiryHours: 0 }, list }); expect(list).not.toHaveBeenCalled();
  });
  it('resolves default, env, invalid and disabled settings with provenance', () => {
    const resolve = env => resolveReviewRedTeamOnSkip({ env, readFile: () => '{}', log: () => {} });
    expect(resolve({}).value.referralRunExpiryHours).toBe(4);
    expect(resolve({ WE_REVIEW_RED_TEAM_ON_SKIP_REFERRAL_RUN_EXPIRY_HOURS: '9' })).toMatchObject({ value: { referralRunExpiryHours: 9 }, sources: { referralRunExpiryHours: 'env' } });
    for (const value of ['-1', 'no', '9007199254740992']) expect(resolve({ WE_REVIEW_RED_TEAM_ON_SKIP_REFERRAL_RUN_EXPIRY_HOURS: value }).value.referralRunExpiryHours).toBe(4);
    expect(resolve({ WE_REVIEW_RED_TEAM_ON_SKIP_REFERRAL_RUN_EXPIRY_HOURS: '0' }).value.referralRunExpiryHours).toBe(0);
    const log = vi.fn(); resolveReviewRedTeamOnSkip({ env: { WE_POLICY_CASCADE_LOG: '1', WE_REVIEW_RED_TEAM_ON_SKIP_REFERRAL_RUN_EXPIRY_HOURS: '13' }, readFile: () => '{}', log });
    expect(log.mock.calls.flat().join(' ')).toContain('referralRunExpiryHours=13 (env)');
  });
  it('judge classification prioritizes suspended runs over live workers and CI', () => {
    expect(needsJudgment({ evidenceErrors: [], openReferrals: [], fixerRunning: true, inCi: true, suspendedReferralRun: { runId: 'r', ageHours: 5 } })).toMatchObject({ needsJudgment: true, reason: 'suspended-referral-run' });
  });
  it.each(['suspended', 'none', 'unreadable'])('judge IO observes %s run evidence', mode => {
    const findSuspendedRuns = () => { if (mode === 'unreadable') throw Error('unreadable dir'); return mode === 'none' ? [] : [{ id: 'stuck', ageMs: 5 * hour }]; };
    const read = createJudgeSweepFactsReader({ checkoutState: () => ({ behind: 0 }), now: () => now,
      gh: () => JSON.stringify([{ number: pr, title: 'fixture', headRefOid: head, baseRefOid: 'b'.repeat(40),
        labels: [], updatedAt: new Date(now).toISOString(), createdAt: new Date(now).toISOString(),
        body: '', author: { login: 'author' }, assignees: [], files: [], changedFiles: 0, statusCheckRollup: [] }]),
      readJobs: () => [], readLedgerRows: () => [], readFixRows: () => [], readComments: () => [],
      shape: () => ({ humanRequired: false }), findSuspendedRuns,
      cache: { get: () => null, set: () => {} } });
    const result = read({ repo }).prs[0];
    expect(result.suspendedReferralRun).toEqual(mode === 'suspended' ? { runId: 'stuck', ageHours: 5 } : null);
    if (mode === 'unreadable') expect(result.evidenceErrors.join(' ')).toContain('suspended referral run evidence unreadable');
  });
  it.each([true, false, 'error'])('daemon expiry %s stays skip and only holds escalate', expired => {
    const escalate = vi.fn(), settle = vi.fn(), setLabels = vi.fn();
    const result = runRedTeamOnSkip({ repo, plan: { refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }] },
      rawPrs: [{ number: pr, headRefOid: head, comments: [], reviews: [], labels: [] }], capacity: { lanes: 1 },
      readEvidence: () => ({ ok: false, reason: 'review-unfinished' }), headNeverReviewed: () => false, readStatus: () => null,
      expireStuckReferralRuns: () => { if (expired === 'error') throw Error('unreadable'); return { expired }; },
      setting: { enabled: true, referralRunExpiryHours: 4 }, escalate, settle, provider: { setLabels }, now: () => now });
    expect(result.rows[0]).toMatchObject({ action: 'skip', why: expired === true ? 'referral-run-expired' : 'review-unfinished' });
    expect(escalate).toHaveBeenCalledTimes(expired === true ? 0 : 1); expect(settle).not.toHaveBeenCalled(); expect(setLabels).not.toHaveBeenCalled();
  });
});
