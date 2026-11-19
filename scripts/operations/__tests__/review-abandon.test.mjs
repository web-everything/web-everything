import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../review-abandon.mjs';
import { newRunRecord, runPath, writeRun } from '../run-store.mjs';
import { abandonedPath, isRunAbandoned, markRunAbandoned } from '../../lib/run-abandoned.mjs';
import { COMMENT_SETTLEABLE_REASONS, readDrainRedTeamEvidence, readRecoveryWitness, settleUnknownEvidenceByComment } from '../../lib/drain-red-team-evidence.mjs';
import { readReviewRunEvidence, findResumableParkedRun } from '../../conveyor/review-referral-hold.mjs';
import { defaultFindResumableRun } from '../review-loop-cli.mjs';
import { findSuspendedReferralRuns } from '../../lib/suspended-referral-run.mjs';
import { headNeverReviewedFromRuns } from '../../lib/review-red-team-on-skip.mjs';
import { closeConfirmRunsAfterClearance } from '../../review-set-label.mjs';

const MIN = 60000, now = Date.parse('2026-11-18T12:00:00Z');
const repo = 'owner/repo', head = 'a'.repeat(40);
let root, dir, env, probes;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'review-abandon-'));
  dir = join(root, 'runs'); mkdirSync(dir);
  env = { OPERATION_RUNS_DIR: dir, WE_SHARED_RUNS_DIR: dir, WE_PLATFORM_PREFERENCES_FILE: join(dir, 'prefs.json') };
  probes = { reviewJobs: () => [], pidIdentity: () => ({ alive: false }), leases: () => '[]', sessions: () => '[]' };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function fixture(pr = 7109, age = 31 * MIN) {
  const id = `review-pr-${pr}`;
  const r = newRunRecord({ id, op: 'review-pr', input: { repo, pr } });
  const types = ['review.comment', 'review.label-swap', 'review.ledger-events', 'review.follow-up'];
  const pendingIndex = pr === 7120 ? 5 : 1;
  r.effects = Array.from({ length: pendingIndex + 3 }, (_, index) => ({ key: `e${index}`, index, stepIndex: 9,
    step: 'record', type: index === pendingIndex ? (pr === 7120 ? 'review.ledger-events' : 'review.label-swap') : types[index % types.length],
    status: index < pendingIndex ? 'applied' : index === pendingIndex ? 'pending' : 'declared',
    ...(index === pendingIndex ? { unknownAttempts: 1 } : {}) }));
  r.pending = { kind: 'effect', step: 'record', stepIndex: 9 };
  r.verdict = { verdict: 'accept' };
  r.findings = { read: { repo, pr, netBasis: { rev: head } } };
  r.stepTimings = [{ step: 'read', stepIndex: 0, startedAt: new Date(now - age - MIN).toISOString() }];
  writeRun(r, dir);
  utimesSync(runPath(id, dir), (now - age) / 1000, (now - age) / 1000);
  return r;
}
function op(args = [], extra = {}) {
  const out = vi.fn(), err = vi.fn();
  const code = main([...args, '--json'], { out, err, reaperOptions: { dir, env, probes, now, ...extra } });
  return { code, result: out.mock.calls.length ? JSON.parse(out.mock.calls[0][0]) : null, err };
}
function evidence(pr = 7109, reader = readDrainRedTeamEvidence) {
  return reader({ repo, pr, head, runsDir: dir, env, now, readScorecards: () => [] });
}
function completed(r, startedAt, id = 'review-pr-replacement', rev = head) {
  const next = structuredClone(r);
  next.id = id; next.pending = null; next.effects = []; next.outcome = null; next.verdict = { verdict: 'accept' };
  next.findings.read.netBasis.rev = rev;
  next.stepTimings = [{ step: 'read', stepIndex: 0, startedAt: new Date(startedAt).toISOString() }];
  writeRun(next, dir);
  utimesSync(runPath(id, dir), (startedAt + 1000) / 1000, (startedAt + 1000) / 1000);
  return next;
}
it.each([7109, 7120])('abandons #%s after 30 minutes without claiming effects applied or rewriting the run', pr => {
  const r = fixture(pr), path = runPath(r.id, dir), bytes = readFileSync(path), mtime = statSync(path).mtimeMs;
  if (pr === 7120) expect(r.effects.filter(e => e.status === 'applied')).toHaveLength(5);
  expect(op([`--run=${r.id}`]).result.wouldReap).toEqual([r.id]);
  expect(isRunAbandoned(r.id, dir)).toBe(false);
  expect(op([`--run=${r.id}`, '--apply']).result.reaped).toEqual([r.id]);
  const t = JSON.parse(readFileSync(abandonedPath(r.id, dir), 'utf8'));
  expect(t.reason).toContain('stuck pending/unknown effect');
  expect(t.reason).toContain('pending step "record"');
  expect(t.reason).toContain(pr === 7120 ? 'review.ledger-events' : 'review.label-swap');
  expect(t.reason).toContain('"status":"pending"');
  expect(t.reason).toContain('abandoned, effect NOT claimed applied');
  expect(t.probes.stuckEffect).toEqual(JSON.parse(JSON.stringify({ pending: r.pending, effects: r.effects.map(({ step, type, status, unknownAttempts }) => ({ step, type, status, unknownAttempts })) })));
  expect(t.probes.thresholdMs).toBe(30 * MIN);
  expect(readFileSync(path)).toEqual(bytes);
  expect(statSync(path).mtimeMs).toBe(mtime);
});
it('onlyIds leaves every other run untouched, while no --run sweeps all', () => {
  const a = fixture(), b = fixture(7120);
  expect(op([`--run=${a.id}`, '--apply']).result.reaped).toEqual([a.id]);
  expect(isRunAbandoned(b.id, dir)).toBe(false);
  expect(op(['--apply']).result.reaped).toEqual([b.id]);
});
it.each([false, true])('refuses a live review-job pid and writer lock (apply=%s)', apply => {
  const r = fixture(), args = apply ? ['--apply'] : [];
  probes.pidIdentity = () => ({ alive: true });
  probes.reviewJobs = () => [{ repo, pr: 7109, pid: 1234 }];
  expect(op(args).result.kept['live-review-job']).toEqual([r.id]);
  probes.reviewJobs = () => [];
  writeFileSync(`${runPath(r.id, dir)}.lock`, '1234');
  expect(op(args).result.kept['live-writer']).toEqual([r.id]);
  expect(isRunAbandoned(r.id, dir)).toBe(false);
});
it('keeps younger-than-threshold stuck runs; a stuck judge-step run is abandoned at its own 30 minute setting', () => {
  const young = fixture(7109, 29 * MIN), other = fixture(7120, 31 * MIN);
  other.pending = { kind: 'judge', step: 'panel', stepIndex: 1 }; other.effects = [];
  writeRun(other, dir); utimesSync(runPath(other.id, dir), (now - 31 * MIN) / 1000, (now - 31 * MIN) / 1000);
  const { result } = op(['--apply']);
  expect(result.kept.young).toEqual([young.id]);
  expect(result.reaped).toEqual([other.id]);
});
it.each(['pending', 'in-flight', 'other'])('explicit thresholdMs wins for %s runs, including --run selection', status => {
  const r = fixture();
  r.effects = status === 'other' ? [] : [{ ...r.effects[1], status }];
  r.pending = { kind: status === 'other' ? 'judge' : 'effect', step: 'record', stepIndex: 9 };
  writeRun(r, dir);
  utimesSync(runPath(r.id, dir), (now - 31 * MIN) / 1000, (now - 31 * MIN) / 1000);
  expect(op([`--run=${r.id}`, '--apply'], { thresholdMs: 60 * MIN }).result.kept.young).toEqual([r.id]);
  expect(isRunAbandoned(r.id, dir)).toBe(false);
  expect(op([`--run=${r.id}`, '--apply'], { thresholdMs: 20 * MIN }).result.reaped).toEqual([r.id]);
  expect(JSON.parse(readFileSync(abandonedPath(r.id, dir), 'utf8')).probes).toMatchObject({ thresholdMs: 20 * MIN, thresholdSource: 'argument' });
});
it.each(['confirm', 'mandatoryReferrals', 'resumed'])('keeps %s continuations on the shorter path', kind => {
  const r = fixture();
  if (kind === 'resumed') r.resumeOf = 'earlier';
  else r.pending = { ...r.pending, ...(kind === 'confirm' ? { kind } : { step: kind }) };
  writeRun(r, dir); utimesSync(runPath(r.id, dir), (now - 8 * 60 * MIN) / 1000, (now - 8 * 60 * MIN) / 1000);
  expect(op(['--apply']).result.kept[kind === 'confirm' ? 'suspended-awaiting-answer' : kind === 'resumed' ? 'resumed-run' : 'suspended-mandatory-referrals']).toEqual([r.id]);
});
it.each(['unreadable', 'oversized', 'changed'])('keeps %s evidence; unreadable probes name retry fallback', mode => {
  const r = fixture();
  probes.sessions = () => {
    if (mode !== 'changed') throw Error(mode === 'oversized' ? 'maxBuffer exceeded' : 'denied');
    r.findings.progress = true; writeRun(r, dir); return '[]';
  };
  const { result, err } = op(['--apply']);
  expect(result.kept[mode === 'changed' ? 'changed-during-sweep' : 'probe-unreadable']).toEqual([r.id]);
  if (mode !== 'changed') expect(err.mock.calls.flat().join(' ')).toContain('restore probe access and retry');
  expect(isRunAbandoned(r.id, dir)).toBe(false);
});
it.each([readDrainRedTeamEvidence, readRecoveryWitness])('gate reader requires a fresh review after abandonment and retains rewritten holds', reader => {
  const r = fixture();
  expect(evidence(7109, reader)).toMatchObject({ ok: false, reason: 'review-unfinished' });
  op(['--apply']);
  expect(evidence(7109, reader)).toMatchObject({ ok: false, reason: 'review-abandoned' });
  expect(evidence(7109, reader).loopPayload).toBeFalsy();
  r.findings.progress = 'new writer'; writeRun(r, dir);
  // Even an old mtime cannot revive a version-bound tombstone after rewriting the record.
  utimesSync(runPath(r.id, dir), (now - 31 * MIN) / 1000, (now - 31 * MIN) / 1000);
  expect(isRunAbandoned(r.id, dir)).toBe(false);
  expect(evidence(7109, reader)).toMatchObject({ ok: false, reason: 'review-unfinished' });
});
it('complete same-head read keeps abandonment owed outside its warm summary cache until a newer completed panel', () => {
  const r = fixture();
  const before = evidence();
  expect(before.settleBounds.completeHeadRead({ pr: 7109, head, at: now + MIN })).toEqual({ complete: true, blocked: true });
  op(['--apply']);
  // New time avoids the per-lookup answer memo; exercises the warm record-summary cache.
  expect(before.settleBounds.completeHeadRead({ pr: 7109, head, at: now + 2 * MIN })).toEqual({ ok: false, reason: 'review-abandoned', complete: true, blocked: true });
  completed(r, now - MIN);
  expect(before.settleBounds.completeHeadRead({ pr: 7109, head, at: now + 3 * MIN })).toEqual({ complete: true, blocked: false });
});
it.each([readDrainRedTeamEvidence, readRecoveryWitness])('does not resurrect older same-head acceptance, even if its mtime is newer', reader => {
  const r = fixture();
  const old = completed(r, now - 60 * MIN, 'review-pr-old');
  utimesSync(runPath(old.id, dir), now / 1000, now / 1000);
  op(['--apply']);
  expect(evidence(7109, reader)).toMatchObject({ ok: false, reason: 'review-abandoned' });
  const next = completed(r, now - MIN);
  const result = evidence(7109, reader);
  expect(result.ok).not.toBe(false);
  expect(result.loopPayload ?? result.newest).toMatchObject({ id: next.id });
});
it.each(['same start', 'older start', 'other head', 'pending', 'refused'])('requires a NEWER completed SAME-head panel: %s cannot discharge abandonment', kind => {
  const r = fixture(), before = evidence();
  op(['--apply']);
  const startedAt = Date.parse(r.stepTimings[0].startedAt);
  const next = completed(r, kind === 'same start' ? startedAt : kind === 'older start' ? startedAt - MIN : now - MIN,
    'review-pr-replacement', kind === 'other head' ? 'b'.repeat(40) : head);
  if (['pending', 'refused'].includes(kind)) {
    next.effects = [{ ...r.effects[1], status: kind,
      ...(kind === 'refused' ? { attempts: 1, error: 'SELF-CLEAR REFUSED before any write' } : {}) }]; writeRun(next, dir);
  }
  expect(evidence()).toMatchObject({ ok: false, reason: 'review-abandoned' });
  expect(before.settleBounds.completeHeadRead({ pr: 7109, head, at: now + MIN })).toMatchObject({ ok: false, reason: 'review-abandoned', blocked: true });
});
it.each([null, { verdict: 'needs-human' }, { verdict: 'prevention-outstanding' }])('tombstoned verdict %j owes a fresh panel and is never comment-settleable', verdict => {
  const r = fixture(); r.verdict = verdict;
  writeRun(r, dir);
  markRunAbandoned({ id: r.id, dir, now, reason: 'historical tombstone', by: 'fixture', probes: {} });
  const result = evidence();
  expect(result).toMatchObject({ ok: false, reason: 'review-abandoned' });
  expect(COMMENT_SETTLEABLE_REASONS).not.toContain('review-abandoned');
  expect(settleUnknownEvidenceByComment(result, [], 7109, head)).toBe(result);
  completed(r, now - MIN);
  expect(evidence().ok).not.toBe(false);
});
it.each(['missing head', 'missing start'])('unreadable abandoned %s never proves a replacement', kind => {
  const r = fixture();
  if (kind === 'missing head') delete r.findings.read.netBasis.rev;
  else r.stepTimings = [];
  writeRun(r, dir);
  markRunAbandoned({ id: r.id, dir, now, reason: 'historical tombstone', by: 'fixture', probes: {} });
  completed(r, now - MIN);
  expect(evidence()).toMatchObject({ ok: false, reason: 'review-abandoned' });
});
it.each([readDrainRedTeamEvidence, readRecoveryWitness])('a capped scan cannot hide an unread startless tombstone behind newer acceptance', reader => {
  const r = fixture(); r.stepTimings = [];
  writeRun(r, dir); utimesSync(runPath(r.id, dir), (now - 31 * MIN) / 1000, (now - 31 * MIN) / 1000);
  markRunAbandoned({ id: r.id, dir, now, reason: 'historical tombstone', by: 'fixture', probes: {} });
  completed(r, now - MIN);
  const warnings = [];
  const result = reader({ repo, pr: 7109, head, runsDir: dir, env, now, readScorecards: () => [],
    scanSettings: { file: { runs: { scan: { maxParses: 1 } } }, env: {} }, warn: message => warnings.push(message) });
  expect(result).toMatchObject({ ok: false, reason: 'scan-capped' });
  expect(warnings.join(' ')).toContain('HOLD and inspect omitted runs');
});
it.each(['changes', 'unknown', {}, false, 0, '', { outcome: 'needs-work' }].flatMap(verdict =>
  ['pending', 'refused'].map(status => [verdict, status])))('rejecting verdict %j with %s effect is kept and a historical tombstone still holds', (verdict, status) => {
  const r = fixture(); r.verdict = verdict; r.effects = [{ ...r.effects[1], status,
    ...(status === 'refused' ? { attempts: 1, error: 'SELF-CLEAR REFUSED before any write' } : {}) }];
  r.outcome = status === 'refused' ? 'refused' : null;
  if (status === 'refused') r.pending = null;
  writeRun(r, dir); utimesSync(runPath(r.id, dir), (now - 8 * 60 * MIN) / 1000, (now - 8 * 60 * MIN) / 1000);
  const before = evidence();
  expect(before).toMatchObject({ ok: false, reason: 'review-unfinished' });
  expect(op(['--apply']).result.kept['rejecting-verdict']).toEqual([r.id]);
  expect(isRunAbandoned(r.id, dir)).toBe(false);
  completed(r, now - 60 * MIN, 'review-pr-old');
  markRunAbandoned({ id: r.id, dir, now, reason: 'historical tombstone', by: 'fixture', probes: {} });
  expect(isRunAbandoned(r.id, dir)).toBe(true);
  for (const reader of [readDrainRedTeamEvidence, readRecoveryWitness]) {
    expect(evidence(7109, reader)).toMatchObject({ ok: false, reason: 'review-unfinished' });
  }
  expect(before.settleBounds.completeHeadRead({ pr: 7109, head, at: now + MIN })).toEqual({ complete: true, blocked: true });
});
it('planner ignores abandoned parked runs, including cached/injected evidence, and sees rewrites again', () => {
  const r = fixture(), pr = { number: 7109, headRefOid: head, comments: [] };
  const rows = readReviewRunEvidence({ dir, persist: false });
  expect(rows).toHaveLength(1);
  const parked = { ...rows[0], retryableRecordEffect: true };
  expect(findResumableParkedRun(pr, [parked], { repo, runsDir: dir })?.id).toBe(r.id);
  op(['--apply']);
  expect(readReviewRunEvidence({ dir, persist: false })).toEqual([]);
  expect(findResumableParkedRun(pr, [parked], { repo, runsDir: dir })).toBeNull();
  expect(defaultFindResumableRun({ repo, pr: 7109 }, { env, readPr: () => pr, readRuns: () => [parked] })).toBeNull();
  r.findings.progress = true; writeRun(r, dir);
  expect(readReviewRunEvidence({ dir, persist: false })).toHaveLength(1);
  expect(findResumableParkedRun(pr, [parked], { repo, runsDir: dir })?.id).toBe(r.id);
});
it('other review readers skip tombstones and their sidecars', () => {
  fixture(); op(['--apply']);
  expect(findSuspendedReferralRuns({ repo, pr: 7109, head, now, runsDir: dir })).toEqual([]);
  expect(headNeverReviewedFromRuns({ repo, pr: 7109, head, env, runsDir: dir })).toBe(true);
  const resume = vi.fn();
  expect(closeConfirmRunsAfterClearance({ repo, pr: 7109, headSha: head, dir, resume })).toEqual({ closed: [], failed: [] });
  expect(resume).not.toHaveBeenCalled();
});
it.each(['--run=', '--run=other', '--run=review-pr-../x', '--aply', '--apply=false'])('invalid flag %s never sweeps', flag => {
  const r = fixture(); expect(op([flag]).code).toBe(2); expect(isRunAbandoned(r.id, dir)).toBe(false);
});
it('resolves minute settings through platform/tool/environment and logs provenance', () => {
  fixture();
  writeFileSync(env.WE_PLATFORM_PREFERENCES_FILE, JSON.stringify({ reviewRunReaper: { abandonStuckAfterMinutes: 60 } }));
  const platform = op(['--apply'], { tool: {} });
  expect(platform.result.kept.young).toEqual(['review-pr-7109']);
  expect(platform.err.mock.calls.flat().join(' ')).toContain('abandonStuckAfterMinutes=60 (platform)');
  expect(op([], { tool: { abandonStuckAfterMinutes: 20 } }).result.wouldReap).toEqual(['review-pr-7109']);
  env.WE_REAP_DEAD_REVIEW_RUNS_STUCK_AFTER_MINUTES = '90';
  const overridden = op([], { tool: { abandonStuckAfterMinutes: 20 } });
  expect(overridden.result.stuckThresholdSource).toBe('env');
  expect(overridden.err.mock.calls.flat().join(' ')).toContain('abandonStuckAfterMinutes=90 (env)');
  env.WE_REAP_DEAD_REVIEW_RUNS_STUCK_AFTER_MINUTES = 'NaN';
  expect(op([], { tool: {} }).result.stuckThresholdSource).toBe('platform');
});

it.each(['pending', 'in-flight'])('abandons %s effects without a verdict or pending cursor', status => {
  const r = fixture(); r.pending = null; r.verdict = null;
  r.effects = [{ ...r.effects[1], status }]; writeRun(r, dir);
  utimesSync(runPath(r.id, dir), (now - 31 * MIN) / 1000, (now - 31 * MIN) / 1000);
  expect(op(['--apply']).result.reaped).toEqual([r.id]);
});
it('retains unreadable settings and corrupt run evidence', () => {
  const r = fixture(); writeFileSync(env.WE_PLATFORM_PREFERENCES_FILE, '{');
  expect(op(['--apply']).code).toBe(1);
  expect(isRunAbandoned(r.id, dir)).toBe(false);
  rmSync(env.WE_PLATFORM_PREFERENCES_FILE); writeFileSync(runPath(r.id, dir), '{');
  expect(op(['--apply']).result.kept.unreadable).toEqual([r.id]);
});
