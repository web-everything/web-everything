import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cliMain, main } from '../review-abandon.mjs';
import { assertRunnerFreshness } from '../runner-freshness.mjs';
import { newRunRecord, runPath, writeRun } from '../run-store.mjs';
import { newJobBlock } from '../job-record.mjs';
import { abandonedPath, isRunAbandoned, markRunAbandoned } from '../../lib/run-abandoned.mjs';
import { COMMENT_SETTLEABLE_REASONS, readDrainRedTeamEvidence, readRecoveryWitness, settleUnknownEvidenceByComment } from '../../lib/drain-red-team-evidence.mjs';
import { readReviewRunEvidence, findResumableParkedRun } from '../../conveyor/review-referral-hold.mjs';
import { defaultFindResumableRun } from '../review-loop-cli.mjs';
import { findSuspendedReferralRuns } from '../../lib/suspended-referral-run.mjs';
import { headNeverReviewedFromRuns } from '../../lib/review-red-team-on-skip.mjs';
import { closeConfirmRunsAfterClearance } from '../../review-set-label.mjs';

const MIN = 60000, now = Date.parse('2026-11-18T12:00:00Z');
const repo = 'owner/repo', head = 'a'.repeat(40);
it('CLI refuses stale apply before main with the shared freshness message and exit code 1', () => {
  const run = vi.fn(), err = vi.fn();
  const assertFresh = vi.fn(options => assertRunnerFreshness(options, {
    env: {}, now: () => 1001,
    filesystem: { realpathSync: p => p, readFileSync: () => JSON.stringify({ remote: 'fixture-origin', ref: 'abc', time: 1000 }) },
    git: args => {
      if (args.includes('--show-toplevel')) return root;
      if (args.includes('--absolute-git-dir')) return join(root, '.git');
      if (args[0] === 'remote') return 'fixture-origin';
      if (args[0] === 'rev-list') return '1';
      if (args[0] === 'fetch') throw Error('unexpected fetch');
      return 'abc';
    },
  }));
  expect(cliMain(['--apply'], { run, err, assertFresh })).toBe(1);
  expect(assertFresh).toHaveBeenCalledWith({ declaration: { name: 'review-abandon', steps: [{ step: { kind: 'effect' } }] },
    moduleUrl: pathToFileURL(join(process.cwd(), 'scripts/operations/review-abandon.mjs')).href });
  expect(err).toHaveBeenCalledTimes(1);
  expect(err).toHaveBeenCalledWith(`Refusing review-abandon: runner ${root}; HEAD abc; refs/remotes/origin/main: 1 commits behind; run from a lane.`);
  expect(run).not.toHaveBeenCalled();
});
it('CLI permits dry-run inspection without freshness checks', () => {
  const assertFresh = vi.fn(() => { throw Error('stale'); }), run = vi.fn(() => 0);
  expect(cliMain(['--json'], { assertFresh, run })).toBe(0);
  expect(assertFresh).not.toHaveBeenCalled();
  expect(run).toHaveBeenCalledTimes(1);
  expect(run).toHaveBeenCalledWith(['--json']);
});
it('CLI checks freshness before a fresh apply and preserves main exit code', () => {
  const order = [], assertFresh = vi.fn(() => { order.push('freshness'); });
  const run = vi.fn(() => { order.push('main'); return 2; });
  expect(cliMain(['--apply', '--json'], { assertFresh, run })).toBe(2);
  expect(order).toEqual(['freshness', 'main']);
  expect(run).toHaveBeenCalledTimes(1);
  expect(run).toHaveBeenCalledWith(['--apply', '--json']);
});
let root, dir, env, probes;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'review-abandon-'));
  dir = join(root, 'runs'); mkdirSync(dir);
  env = { OPERATION_RUNS_DIR: dir, WE_SHARED_RUNS_DIR: dir, WE_PLATFORM_PREFERENCES_FILE: join(dir, 'prefs.json') };
  probes = { prStates: (_repo, numbers) => new Map(numbers.map(pr => [pr, 'OPEN'])), reviewJobs: () => [], pidIdentity: () => ({ alive: false }), leases: () => '[]', sessions: () => '[]' };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function fixture(pr = 7109, age = 31 * MIN) {
  const id = `review-pr-${pr}`;
  const r = newRunRecord({ id, op: 'review-pr', input: { repo, pr } });
  const types = ['review.label-swap', 'verdict-ledger.append', 'review.notice', 'review.ledger-events'];
  const pendingIndex = pr === 7120 ? 5 : 1;
  r.effects = Array.from({ length: pendingIndex + 3 }, (_, index) => ({ key: `e${index}`, index, stepIndex: 9,
    step: 'record', type: index === pendingIndex ? (pr === 7120 ? 'review.ledger-events' : 'review.label-swap') : types[index % types.length],
    status: index < pendingIndex ? 'applied' : index === pendingIndex ? 'pending' : 'declared',
    payload: { to: 'accepted', verdict: 'accept' },
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
  next.id = id; next.pending = null; next.outcome = null; next.verdict = { verdict: 'accept' };
  // Completed accepts deliver the record step's label, ledger and notice effects.
  next.effects = ['review.label-swap', 'verdict-ledger.append', 'review.notice'].map((type, index) => ({
    key: `completed-${index}`, type, index, stepIndex: 9, step: 'record', status: 'applied',
    payload: { to: 'accepted', verdict: 'accept' }, result: { ok: true },
  }));
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
  completed(r, now + 1000);
  expect(before.settleBounds.completeHeadRead({ pr: 7109, head, at: now + 3 * MIN })).toEqual({ complete: true, blocked: false });
});
it.each([readDrainRedTeamEvidence, readRecoveryWitness])('does not resurrect older same-head acceptance, even if its mtime is newer', reader => {
  const r = fixture();
  const old = completed(r, now - 60 * MIN, 'review-pr-old');
  utimesSync(runPath(old.id, dir), now / 1000, now / 1000);
  op(['--apply']);
  expect(evidence(7109, reader)).toMatchObject({ ok: false, reason: 'review-abandoned' });
  const next = completed(r, now + 1000);
  const result = evidence(7109, reader);
  expect(result.ok).not.toBe(false);
  expect(result.loopPayload ?? result.newest).toMatchObject({ id: next.id });
});
it.each(['same start', 'older start', 'before tombstone', 'at tombstone', 'other head', 'pending', 'refused'])('requires a completed SAME-head panel STARTED AFTER the tombstone: %s cannot discharge abandonment', kind => {
  const r = fixture(), before = evidence();
  op(['--apply']);
  const startedAt = Date.parse(r.stepTimings[0].startedAt);
  const next = completed(r, kind === 'same start' ? startedAt : kind === 'older start' ? startedAt - MIN
    : kind === 'before tombstone' ? now - MIN : kind === 'at tombstone' ? now : now + 1000,
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
  completed(r, now + 1000);
  expect(evidence().ok).not.toBe(false);
});
it.each(['new', 'legacy'])('%s tombstone time requires a complete same-head review started after abandonment in both readers', location => {
  const r = fixture();
  const before = [readDrainRedTeamEvidence, readRecoveryWitness].map(reader => evidence(7109, reader));
  op(['--apply']);
  if (location === 'legacy') renameSync(abandonedPath(r.id, dir), join(dir, `${r.id}.abandoned.json`));
  // This accept both started and completed after the old read start but before abandonment.
  completed(r, now - MIN);
  for (const [index, reader] of [readDrainRedTeamEvidence, readRecoveryWitness].entries()) {
    expect(evidence(7109, reader)).toMatchObject({ ok: false, reason: 'review-abandoned' });
    expect(before[index].settleBounds.completeHeadRead({ pr: 7109, head, at: now + MIN }))
      .toMatchObject({ reason: 'review-abandoned', complete: true, blocked: true });
  }
  completed(r, now + 1000);
  for (const [index, reader] of [readDrainRedTeamEvidence, readRecoveryWitness].entries()) {
    expect(evidence(7109, reader).ok).not.toBe(false);
    expect(before[index].settleBounds.completeHeadRead({ pr: 7109, head, at: now + 2 * MIN }))
      .toEqual({ complete: true, blocked: false });
  }
});
it.each(['platform', 'tool'])('does not shorten %s abandonAfterHours for runs without a pending cursor or active effect', source => {
  const r = fixture(); r.pending = null; r.effects = [];
  writeRun(r, dir);
  utimesSync(runPath(r.id, dir), (now - 8 * 60 * MIN) / 1000, (now - 8 * 60 * MIN) / 1000);
  const settings = { abandonAfterHours: 9, abandonStuckAfterMinutes: 1, abandonStuckJudgeAfterMinutes: 1 };
  if (source === 'platform') writeFileSync(env.WE_PLATFORM_PREFERENCES_FILE, JSON.stringify({ reviewRunReaper: settings }));
  const extra = { tool: source === 'tool' ? settings : {} };
  expect(op(['--apply'], extra).result.kept.terminal).toEqual([r.id]);
  // Exercise the ordinary horizon even if a caller supplies a stricter terminal classifier.
  extra.store = { isRunRecordTerminal: () => false };
  const held = op(['--apply'], extra);
  expect(held.result.kept.young).toEqual([r.id]);
  expect(held.result.thresholdMs).toBe(9 * 60 * MIN);
  expect(held.result.thresholdSource).toBe(source);
  expect(held.err.mock.calls.flat().join(' ')).toContain(`abandonAfterHours=9 (${source})`);
  expect(isRunAbandoned(r.id, dir)).toBe(false);
  expect(op(['--apply'], { ...extra, thresholdMs: 7 * 60 * MIN }).result.reaped).toEqual([r.id]);
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
  expect(readReviewRunEvidence({ dir, persist: false }).map(r => r.id)).toEqual([r.id]); // abandonment retains the spent retry
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


it.each([[], ['--allow-resumed'], ['--ruling=decision-13']].map(flags => ({ flags })))('explicit resumed run stays kept with incomplete override flags $flags', ({ flags }) => {
  const r = fixture(); r.resumeOf = 'earlier'; r.resumedAt = new Date(now - 60 * MIN).toISOString();
  writeRun(r, dir); utimesSync(runPath(r.id, dir), (now - 31 * MIN) / 1000, (now - 31 * MIN) / 1000);
  const result = op([`--run=${r.id}`, '--apply', ...flags]);
  expect(result.code).toBe(0);
  expect(result.result.kept['resumed-run']).toEqual([r.id]);
  expect(isRunAbandoned(r.id, dir)).toBe(false);
});
it.each(['resumeOf', 'resumedAt'])('explicit %s run can be abandoned with both override flags and preserves the ruling verbatim', field => {
  const r = fixture(); r[field] = field === 'resumeOf' ? 'earlier' : new Date(now - 60 * MIN).toISOString();
  writeRun(r, dir); utimesSync(runPath(r.id, dir), (now - 31 * MIN) / 1000, (now - 31 * MIN) / 1000);
  const ruling = 'decision-13: approved $(literal)';
  const args = [`--run=${r.id}`, '--allow-resumed', `--ruling=${ruling}`];
  expect(op(args).result.wouldReap).toEqual([r.id]);
  expect(op([...args, '--apply']).result.reaped).toEqual([r.id]);
  const tombstone = JSON.parse(readFileSync(abandonedPath(r.id, dir), 'utf8'));
  expect(tombstone.reason).toContain(`resumed run overridden; ruling=${ruling};`);
  expect(tombstone.probes).toMatchObject({ ruling, resumeOverridden: true, thresholdMs: 30 * MIN });
});
it.each(['live-pid', 'live-writer', 'live-lease', 'live-session', 'young', 'rejecting-verdict'])('ruled resumed override still refuses %s', reason => {
  const r = fixture(); r.resumeOf = 'earlier';
  if (reason === 'live-pid') { r.job = { ...newJobBlock({ kind: 'review' }), pid: 1234 }; probes.pidIdentity = () => ({ alive: true }); }
  if (reason === 'live-writer') { writeFileSync(join(dir, `${r.id}.json.lock`), '1234'); probes.pidIdentity = () => ({ alive: true }); }
  if (reason === 'live-lease') probes.leases = () => r.id;
  if (reason === 'live-session') probes.sessions = () => r.id;
  if (reason === 'rejecting-verdict') r.verdict = { verdict: 'changes' };
  writeRun(r, dir); utimesSync(runPath(r.id, dir), (now - (reason === 'young' ? 29 : 31) * MIN) / 1000, (now - (reason === 'young' ? 29 : 31) * MIN) / 1000);
  const result = op([`--run=${r.id}`, '--allow-resumed', '--ruling=decision-13', '--apply']);
  expect(result.result.kept[reason]).toEqual([r.id]);
  expect(isRunAbandoned(r.id, dir)).toBe(false);
});
it.each([['--allow-resumed'], ['--ruling=decision-13'], ['--allow-resumed', '--ruling=decision-13']].map(flags => ({ flags })))('override flags $flags without --run refuse with exit 2', ({ flags }) => {
  const r = fixture(); const result = op([...flags, '--apply']);
  expect(result.code).toBe(2); expect(result.result).toBeNull();
  expect(isRunAbandoned(r.id, dir)).toBe(false);
});
