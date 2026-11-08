import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { hostname, tmpdir } from 'node:os';
import { pidNamespace } from '../pid-alive.mjs';
import { newRunRecord, readRun, writeRun, runPath } from '../../operations/run-store.mjs';
import { findSuspendedReferralRuns, planReferralExpiry, expireSuspendedReferralRun, expireStuckReferralRuns } from '../stuck-referral-expiry.mjs';
import { readDrainRedTeamEvidence, ABANDONED_REVIEW_AFTER_MS } from '../drain-red-team-evidence.mjs';
import { resolveReviewRedTeamOnSkip, runRedTeamOnSkip } from '../review-red-team-on-skip.mjs';
import { needsJudgment } from '../../operations/judge-sweep-facts.mjs';
import { createJudgeSweepFactsReader } from '../../operations/judge-sweep-facts-io.mjs';
const repo = 'o/r', pr = 1, head = 'a'.repeat(40), now = Date.now(), hour = 3600000, deadlineMs = 45 * 60000;
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
  return { runsDir, runId: run.id, repo, pr, head, now, deadlineMs, probe: { isRunBound: () => false } };
}
const bytes = f => readFileSync(runPath(f.runId, f.runsDir), 'utf8');
describe('stuck referral expiry', () => {
  it('expires a suspended run with no owner past the window without a verdict or acceptance and the real drain abandons it after its horizon', () => {
    const f = fixture();
    const evidence = at => readDrainRedTeamEvidence({ ...f, now: at, readScorecards: () => [], env: { OPERATION_RUNS_DIR: f.runsDir, WE_SHARED_RUNS_DIR: join(f.runsDir, 'shared', 'runs') } });
    expect(evidence(now)).toMatchObject({ ok: false, reason: 'review-unfinished' });
    expect(expireSuspendedReferralRun(f)).toEqual({ expired: true, runId: f.runId, deadlineMs });
    const run = readRun(f.runId, f.runsDir);
    expect(run.pending).toBeNull(); expect(run.verdict).toBeNull();
    expect(run.expired).toMatchObject({ reason: 'expired: no referral ruling within 45m', deadlineMs: 45 * 60000 });
    expect(run.effects.every(e => e.status === 'failed' && e.error.startsWith('expired: no referral ruling within'))).toBe(true);
    const abandoned = evidence(Date.now() + ABANDONED_REVIEW_AFTER_MS + 5000);
    expect(abandoned.reason).not.toBe('review-unfinished');
    expect(abandoned).toEqual({ loopPayload: null, inFlight: false, scheduled: false, recorded: false,
      seatRecorded: false, completedRecorded: false, failedSeatCount: 0 });
  });
  it('planner only expires or holds, never clears or accepts', () => {
    const f = fixture(), run = findSuspendedReferralRuns(f)[0];
    expect(planReferralExpiry(run, { now, deadlineMs, probe: f.probe, live: false }).action).toBe('expire');
    expect(planReferralExpiry(run, { now, deadlineMs, live: true }).action).toBe('hold');
  });
  it('holds suspended runs with no owner within the window byte-identically', () => {
    const f = fixture(30 * 60000), before = bytes(f);
    expect(expireSuspendedReferralRun(f).expired).toBe(false); expect(bytes(f)).toBe(before);
  });
  it.each([
    ['live process bound to run id', () => true, 'run bound to live process'],
    ['throwing owner probe', () => { throw Error('ps unreadable'); }, 'run owner unreadable'],
    ['non-boolean owner probe', () => null, 'run owner unreadable'],
    ['missing owner probe', undefined, 'run owner unreadable'],
  ])('holds %s without writing', (_name, isRunBound, why) => {
    const f = fixture(), before = bytes(f), write = vi.fn();
    const bound = isRunBound && vi.fn(isRunBound);
    expect(expireSuspendedReferralRun({ ...f, probe: { isRunBound: bound }, write }))
      .toMatchObject({ expired: false, why });
    if (bound) expect(bound).toHaveBeenCalledWith(f.runId);
    expect(write).not.toHaveBeenCalled(); expect(bytes(f)).toBe(before);
  });
  it('rechecks process ownership before writing', () => {
    const f = fixture(), before = bytes(f), write = vi.fn();
    const isRunBound = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    expect(expireSuspendedReferralRun({ ...f, probe: { isRunBound }, write }))
      .toMatchObject({ expired: false, why: 'run bound to live process' });
    expect(isRunBound).toHaveBeenCalledTimes(2);
    expect(write).not.toHaveBeenCalled(); expect(bytes(f)).toBe(before);
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
  });
  it('holds null liveness on a valid suspended observation', () => {
    const f = fixture(), observation = findSuspendedReferralRuns(f)[0];
    expect(planReferralExpiry(observation, { now, deadlineMs, probe: f.probe, live: false }).action).toBe('expire');
    expect(planReferralExpiry(observation, { now, deadlineMs, live: null })).toEqual({ action: 'hold', why: 'liveness unreadable' });
  });
  it.each(['EIO', 'ESRCH', 'EPERM', null])('default pid probe handles %s without treating unknown errors as dead', code => {
    const f = fixture(5 * hour, { host: hostname(), pidNamespace: pidNamespace(), pid: 123 }), before = bytes(f);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      if (code) throw Object.assign(Error(code), { code });
      return true;
    });
    let result;
    try {
      result = expireSuspendedReferralRun({ ...f, probe: undefined });
      expect(kill).toHaveBeenCalledWith(123, 0);
    } finally { kill.mockRestore(); }
    expect(result).toMatchObject(code === 'ESRCH' ? { expired: true }
      : { expired: false, why: code === 'EIO' ? 'owner liveness unreadable' : 'owner live' });
    if (code !== 'ESRCH') expect(bytes(f)).toBe(before);
  });
  it('holds non-finite mtime despite an old completed step without writing', () => {
    const f = fixture(5 * hour, { stepTimings: [{ step: 'read', stepIndex: 0,
      startedAt: new Date(now - 6 * hour).toISOString(), finishedAt: new Date(now - 5 * hour).toISOString(), durationMs: hour }] });
    const before = bytes(f), write = vi.fn(), stat = () => ({ mtimeMs: NaN });
    expect(() => findSuspendedReferralRuns({ ...f, stat })).toThrow('age unreadable');
    expect(expireSuspendedReferralRun({ ...f, stat, write })).toMatchObject({ expired: false, why: 'run evidence unreadable; inspect run store' });
    expect(write).not.toHaveBeenCalled(); expect(bytes(f)).toBe(before);
  });
  it.each([{ resumedAt: new Date(now - 15 * 60000).toISOString() }, { resumeOf: 'prior' }])('holds recent or unknown resumes %j', extra => {
    const f = fixture(5 * hour, extra); expect(expireSuspendedReferralRun(f).expired).toBe(false);
  });
  it('holds a live session and a present verdict without changing bytes', () => {
    const f = fixture(5 * hour, { sessionId: 'session' }), before = bytes(f);
    expect(expireSuspendedReferralRun({ ...f, probe: { isSessionAlive: () => true } }).expired).toBe(false);
    expect(bytes(f)).toBe(before);
    const decided = fixture(5 * hour, { verdict: { verdict: 'changes' } }), decidedBefore = bytes(decided);
    expect(expireSuspendedReferralRun(decided).expired).toBe(false); expect(bytes(decided)).toBe(decidedBefore);
  });
  it.each([
    [{ host: 'elsewhere', pid: 123 }, { host: 'local' }, 'owner on another host; unverifiable'],
    [{ host: 'local', pidNamespace: 'foreign', pid: 123 }, { host: 'local', namespace: 'local' }, 'owner on another host; unverifiable'],
    [{ host: 'local', pidNamespace: 'ns', pid: 123 }, { host: 'local', namespace: 'ns', isAlive: () => { throw Error('probe failed'); } }, 'owner liveness unreadable'],
    [{ sessionId: 'session' }, {}, 'session liveness unverifiable'],
  ])('holds unverifiable owner %j without writing', (owner, probe, why) => {
    const f = fixture(5 * hour, owner), before = bytes(f);
    expect(planReferralExpiry(findSuspendedReferralRuns(f)[0], { now, deadlineMs, probe })).toEqual({ action: 'hold', why });
    expect(expireSuspendedReferralRun({ ...f, probe })).toMatchObject({ expired: false, why });
    expect(bytes(f)).toBe(before);
  });
  it.each(['record-referral-ruling', 'review-ruling-resume'])('holds old open %s by PR or named run, but allows old terminal rulings', op => {
    for (const named of [false, true]) {
      const f = fixture(), before = bytes(f);
      const ruling = newRunRecord({ id: 'ruling-old', op, input: named ? { repo: 'other/repo', pr: 99 } : { repo, pr } });
      if (named) ruling.verdict = { record: { rulings: [{ runId: f.runId }] } };
      // Both cursor-only and in-flight-only records are nonterminal.
      if (named) ruling.effects = [{ key: 'ruling', type: 'ruling', stepIndex: 0, index: 0, status: 'in-flight' }];
      else ruling.pending = { kind: 'effect', step: 'record', stepIndex: 0, count: 1 };
      const save = () => { writeRun(ruling, f.runsDir); utimesSync(runPath(ruling.id, f.runsDir), (now - 8 * hour) / 1000, (now - 8 * hour) / 1000); };
      save();
      expect(findSuspendedReferralRuns(f)[0].rulingOpen).toBe(true);
      expect(expireSuspendedReferralRun(f)).toMatchObject({ expired: false, why: 'referral ruling open' });
      expect(bytes(f)).toBe(before);
      ruling.pending = null; ruling.effects = []; save();
      expect(findSuspendedReferralRuns(f)[0].rulingOpen).toBe(false);
      expect(expireSuspendedReferralRun(f).expired).toBe(true);
    }
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
    expect(expireStuckReferralRuns({ ...f, setting: { value: { referralRunExpiryMinutes: 45 }, sources: { referralRunExpiryMinutes: 'tool' } }, log }).expired).toBe(true);
    expect(log).toHaveBeenCalledWith(`stuck-referral-expiry: ${repo}#${pr} run=${f.runId} expired deadline=45m source=tool`);
    const list = vi.fn(); expireStuckReferralRuns({ ...f, setting: { referralRunExpiryMinutes: 0 }, list }); expect(list).not.toHaveBeenCalled();
  });
  it('resolves default, env, invalid and disabled settings with provenance', () => {
    const resolve = env => resolveReviewRedTeamOnSkip({ env, readFile: () => '{}', log: () => {} });
    expect(resolve({}).value.referralRunExpiryMinutes).toBe(45);
    expect(resolve({ WE_REVIEW_RED_TEAM_ON_SKIP_REFERRAL_RUN_EXPIRY_MIN: '9' })).toMatchObject({ value: { referralRunExpiryMinutes: 9 }, sources: { referralRunExpiryMinutes: 'env' } });
    for (const value of ['-1', 'no', '9007199254740992']) expect(resolve({ WE_REVIEW_RED_TEAM_ON_SKIP_REFERRAL_RUN_EXPIRY_MIN: value }).value.referralRunExpiryMinutes).toBe(45);
    expect(resolve({ WE_REVIEW_RED_TEAM_ON_SKIP_REFERRAL_RUN_EXPIRY_MIN: '0' }).value.referralRunExpiryMinutes).toBe(0);
    const log = vi.fn(); resolveReviewRedTeamOnSkip({ env: { WE_POLICY_CASCADE_LOG: '1', WE_REVIEW_RED_TEAM_ON_SKIP_REFERRAL_RUN_EXPIRY_MIN: '13' }, readFile: () => '{}', log });
    expect(log.mock.calls.flat().join(' ')).toContain('referralRunExpiryMinutes=13 (env)');
  });
  it('judge classification prioritizes suspended runs over live workers and CI', () => {
    expect(needsJudgment({ evidenceErrors: [], openReferrals: [], fixerRunning: true, inCi: true, suspendedReferralRun: { runId: 'r', ageHours: 0, ageMinutes: 0 } })).toMatchObject({ needsJudgment: true, reason: 'suspended-referral-run' });
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
    expect(result.suspendedReferralRun).toEqual(mode === 'suspended' ? { runId: 'stuck', ageHours: 5, ageMinutes: 300 } : null);
    if (mode === 'unreadable') expect(result.evidenceErrors.join(' ')).toContain('suspended referral run evidence unreadable');
  });
  it.each(['live', 'write-error'])('mixed expiry with a %s blocker keeps the daemon escalation', blocker => {
    const f = fixture();
    const blocked = { ...readRun(f.runId, f.runsDir), id: 'review-pr-blocked', host: 'local', pidNamespace: 'ns', pid: 123 };
    writeRun(blocked, f.runsDir);
    utimesSync(runPath(blocked.id, f.runsDir), (now - 5 * hour) / 1000, (now - 5 * hour) / 1000);
    const before = readFileSync(runPath(blocked.id, f.runsDir), 'utf8');
    const escalate = vi.fn(), expiry = vi.fn(options => expireStuckReferralRuns({ ...options, runsDir: f.runsDir,
      probe: { host: 'local', namespace: 'ns', isAlive: () => blocker === 'live', isRunBound: () => false },
      write: (run, dir) => { if (run.id === blocked.id && blocker === 'write-error') throw Error('write failed'); writeRun(run, dir); } }));
    const result = runRedTeamOnSkip({ repo, plan: { refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }] },
      rawPrs: [{ number: pr, headRefOid: head, comments: [], reviews: [], labels: [] }], capacity: { lanes: 1 },
      readEvidence: () => ({ ok: false, reason: 'review-unfinished' }), headNeverReviewed: () => false, readStatus: () => null,
      expireStuckReferralRuns: expiry, setting: { enabled: true, referralRunExpiryMinutes: 45 }, escalate, now: () => now });
    expect(expiry).toHaveBeenCalledTimes(1);
    expect(expiry.mock.results[0].value).toEqual({ expired: false, held: [{ expired: false, runId: blocked.id,
      why: blocker === 'live' ? 'owner live' : 'run evidence unreadable; inspect run store' }] });
    expect(readRun(f.runId, f.runsDir).pending).toBeNull();
    expect(readFileSync(runPath(blocked.id, f.runsDir), 'utf8')).toBe(before);
    expect(result.rows[0]).toMatchObject({ action: 'skip', why: 'review-unfinished' });
    expect(escalate).toHaveBeenCalledWith(expect.objectContaining({ why: 'review-unfinished' }));
  });
  it.each([head, 'b'.repeat(40)])('expires a referral but keeps escalation for unfinished review on head %s', otherHead => {
    const f = fixture();
    const blocked = { ...readRun(f.runId, f.runsDir), id: 'review-pr-confirm', effects: [], findings: { read: { netBasis: { rev: otherHead } } },
      pending: { kind: 'confirm', step: 'stageVerdict', stepIndex: 9 } };
    writeRun(blocked, f.runsDir);
    const before = readFileSync(runPath(blocked.id, f.runsDir), 'utf8');
    const escalate = vi.fn(), expiry = vi.fn(options => expireStuckReferralRuns({ ...options, runsDir: f.runsDir, probe: f.probe }));
    const result = runRedTeamOnSkip({ repo, plan: { refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }] },
      rawPrs: [{ number: pr, headRefOid: head, comments: [], reviews: [], labels: [] }], capacity: { lanes: 1 },
      readEvidence: () => ({ ok: false, reason: 'review-unfinished' }), headNeverReviewed: () => false, readStatus: () => null,
      expireStuckReferralRuns: expiry, setting: { enabled: true, referralRunExpiryMinutes: 45 }, escalate, now: () => now });
    expect(escalate).toHaveBeenCalledTimes(1);
    expect(expiry.mock.results[0].value).toEqual({ expired: true, otherBlockers: 1 });
    expect(readRun(f.runId, f.runsDir).pending).toBeNull();
    expect(readFileSync(runPath(blocked.id, f.runsDir), 'utf8')).toBe(before);
    expect(result.rows[0]).toMatchObject({ action: 'skip', why: 'review-unfinished' });
    expect(escalate).toHaveBeenCalledTimes(1);
    expect(escalate).toHaveBeenCalledWith(expect.objectContaining({ why: 'review-unfinished' }));
  });
  it.each([
    ['recent terminal', {}, 0, 1],
    ['abandoned terminal', {}, 2 * hour, 0],
    ['resumed terminal', { resumeOf: 'prior' }, 2 * hour, 1],
    ['open effect with verdict', { verdict: { verdict: 'changes' }, effects: [{ key: 'open', type: 'test', stepIndex: 0, index: 0, status: 'pending' }] }, 2 * hour, 1],
    ['finished verdict', { verdict: { verdict: 'changes' } }, 0, 0],
    ['other head', { input: { repo, pr, head: 'b'.repeat(40) }, findings: {} }, 0, 1],
    ['read rev overrides input head', { input: { repo, pr, head: 'b'.repeat(40) }, findings: { read: { netBasis: { rev: head } } } }, 0, 1],
    ['input head fallback', { input: { repo, pr, head }, findings: {} }, 0, 1],
    ['other repo', { input: { repo: 'elsewhere/repo', pr } }, 0, 0],
    ['other PR', { input: { repo, pr: 2 } }, 0, 0],
  ])('counts other blockers: %s', (_name, extra, age, count) => {
    const f = fixture();
    const other = { ...readRun(f.runId, f.runsDir), id: 'review-pr-other', pending: null, effects: [], ...extra };
    writeRun(other, f.runsDir);
    utimesSync(runPath(other.id, f.runsDir), (now - age) / 1000, (now - age) / 1000);
    expect(expireStuckReferralRuns({ ...f, setting: { referralRunExpiryMinutes: 45 } })).toEqual({ expired: true, otherBlockers: count });
  });
  it('fails closed on an unfinished stageVerdict review with missing input.repo after expiry', () => {
    const f = fixture();
    const blocked = { ...newRunRecord({ id: 'review-pr-missing-repo', op: 'review-pr', input: { pr } }),
      pending: { kind: 'confirm', step: 'stageVerdict', stepIndex: 9 } };
    writeRun(blocked, f.runsDir);
    expect(expireStuckReferralRuns({ ...f, setting: { referralRunExpiryMinutes: 45 } }))
      .toEqual({ expired: true, otherBlockers: 1 });
    expect(readRun(f.runId, f.runsDir).pending).toBeNull();
  });
  it.each([
    ['missing PR', 'review-pr', { repo }, 1],
    ['unreadable repo', 'review-pr', { repo: 42, pr }, 1],
    ['unreadable PR', 'review-pr', { repo, pr: String(pr) }, 1],
    ['unknown operation and identity', 'legacy-review', {}, 1],
    ['known other repo with missing PR', 'review-pr', { repo: 'elsewhere/repo' }, 0],
    ['known other PR with missing repo', 'review-pr', { pr: 2 }, 0],
  ])('post-expiry identity scan: %s', (_name, op, input, otherBlockers) => {
    const f = fixture();
    const blocked = { ...newRunRecord({ id: 'review-identity', op, input }),
      pending: { kind: 'confirm', step: 'stageVerdict', stepIndex: 9 } };
    writeRun(blocked, f.runsDir);
    expect(expireStuckReferralRuns({ ...f, setting: { referralRunExpiryMinutes: 45 } }))
      .toEqual({ expired: true, otherBlockers });
  });
  it('counts unreadable post-expiry evidence as a blocker', () => {
    const f = fixture(); let expired = false;
    const result = expireStuckReferralRuns({ ...f, setting: { referralRunExpiryMinutes: 45 },
      read: (id, dir) => { if (expired) throw Error('unreadable'); return readRun(id, dir); },
      write: (run, dir) => { writeRun(run, dir); expired = true; } });
    expect(result).toEqual({ expired: true, otherBlockers: 1 });
  });
  it.each([true, false, 'error'])('daemon expiry %s stays skip and only holds escalate', expired => {
    const escalate = vi.fn(), settle = vi.fn(), setLabels = vi.fn();
    const result = runRedTeamOnSkip({ repo, plan: { refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }] },
      rawPrs: [{ number: pr, headRefOid: head, comments: [], reviews: [], labels: [] }], capacity: { lanes: 1 },
      readEvidence: () => ({ ok: false, reason: 'review-unfinished' }), headNeverReviewed: () => false, readStatus: () => null,
      expireStuckReferralRuns: () => { if (expired === 'error') throw Error('unreadable'); return { expired, otherBlockers: 0 }; },
      setting: { enabled: true, referralRunExpiryMinutes: 45 }, escalate, settle, provider: { setLabels }, now: () => now });
    expect(result.rows[0]).toMatchObject({ action: 'skip', why: expired === true ? 'referral-run-expired' : 'review-unfinished' });
    expect(escalate).toHaveBeenCalledTimes(expired === true ? 0 : 1); expect(settle).not.toHaveBeenCalled(); expect(setLabels).not.toHaveBeenCalled();
  });
});
