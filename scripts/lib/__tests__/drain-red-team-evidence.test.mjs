// @vitest-environment node
import { beforeEach as beforeTimingFixture, afterEach as afterTimingFixture, vi as timingFixture } from 'vitest';
beforeTimingFixture(() => timingFixture.stubEnv('WE_RED_TEAM_TIMING', 'post-accept'));
afterTimingFixture(() => timingFixture.unstubAllEnvs());
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { saveProvenanceFixtures } from './fixtures/saved-red-team-provenance.mjs';
import { resolveScorecardStorePath } from '../../conveyor/run-scorecard-store.mjs';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
import { dirname, join } from 'node:path';
import { newRunRecord, writeRun } from '../../operations/run-store.mjs';
import { readDrainRedTeamEvidence, recordRedTeamStatus, redTeamStatusDir } from '../drain-red-team-evidence.mjs';
import { redTeamEnqueueHold } from '../drain-queue-safety.mjs';
import { pidStartTime } from '../pid-alive.mjs';
import { planRedTeamStatusLabels } from '../red-team-status-labels.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'drain-red-team-'));
  roots.push(root);
  const runsDir = join(root, 'runs');
  return { repo: 'web-everything/web-everything', pr: 5439, head: 'b'.repeat(40), runsDir,
    readScorecards: () => [], env: { WE_RED_TEAM_TIMING: 'post-accept', WE_SHARED_RUNS_DIR: runsDir, CONVEYOR_STATE_ROOT: root } };
}
const payload = head => ({ verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev: head } } } });

describe('drain reads actual head-bound review scheduler inputs', () => {
  it('does not invent an accept when no review run exists', () => {
    expect(readDrainRedTeamEvidence(fixture())).toEqual({ loopPayload: null, recorded: false, scheduled: false, inFlight: false, attempted: false, noUsableResult: true });
  });
  it('pins the accepted-label boundary with empty status and run stores', () => {
    const f = fixture();
    const evidence = readDrainRedTeamEvidence(f);
    // #5439/#5443: an acceptance label alone cannot invent scheduler work that never existed.
    expect(redTeamEnqueueHold({ ...f, ...evidence, labels: ['review:accepted'], comments: [] })).toBeNull();
    // A persisted accepting verdict holds before the job publishes its first status: the loop applies the labels
    // before the job can write one. It is not a live queue entry, so the never-scheduled deadline still applies.
    const run = { ...newRunRecord({ id: 'review-pr-5439', op: 'review-pr', input: { repo: f.repo, pr: f.pr } }), ...payload(f.head) };
    writeRun(run, f.runsDir);
    expect(readDrainRedTeamEvidence(f)).toMatchObject({ scheduled: true, inFlight: false, recorded: false });
    expect(readDrainRedTeamEvidence(f).queued).toBeUndefined();
    expect(redTeamEnqueueHold({ ...f, ...readDrainRedTeamEvidence(f), labels: ['review:accepted'], comments: [] })).toMatch(/no recorded result/);
    // A disabled scheduler or a non-accepting run schedules nothing; the job's finished status supersedes the run.
    expect(redTeamEnqueueHold({ ...f, ...readDrainRedTeamEvidence({ ...f, env: { WE_RED_TEAM_TIMING: 'post-accept', ...f.env, WE_REVIEW_RED_TEAM: 'off' } }), comments: [] })).toBeNull();
    writeRun({ ...run, verdict: { verdict: 'changes' } }, f.runsDir);
    expect(readDrainRedTeamEvidence(f).scheduled).toBe(false);
    writeRun(run, f.runsDir);
    recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'finished', result: 'skipped' }, f);
    expect(redTeamEnqueueHold({ ...f, ...readDrainRedTeamEvidence(f), comments: [] })).toBeNull();
  });
  it('an earlier finished status on the same head never supersedes a newer accepting run', () => {
    const f = fixture();
    // Review 1 of this head did not accept; a re-review of the unchanged head accepts before its job writes a status.
    recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'finished', result: 'not-owed' }, f);
    const statusFile = join(redTeamStatusDir(f.env), `${encodeURIComponent(f.repo)}-${f.pr}-${f.head}.json`);
    utimesSync(statusFile, new Date(1_000_000), new Date(1_000_000));
    expect(redTeamEnqueueHold({ ...f, ...readDrainRedTeamEvidence(f), comments: [] })).toBeNull();
    writeRun({ ...newRunRecord({ id: 'review-pr-2', op: 'review-pr', input: { repo: f.repo, pr: f.pr } }), ...payload(f.head) }, f.runsDir);
    expect(readDrainRedTeamEvidence(f)).toMatchObject({ scheduled: true, inFlight: false });
    expect(redTeamEnqueueHold({ ...f, ...readDrainRedTeamEvidence(f), comments: [] })).toMatch(/no recorded result/);
    // The re-review's own later status supersedes the run again.
    recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'finished', result: 'skipped' }, f);
    expect(redTeamEnqueueHold({ ...f, ...readDrainRedTeamEvidence(f), comments: [] })).toBeNull();
  });
  it('recognizes queued scheduling for the live head only while its writer is alive', () => {
    const f = fixture();
    recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'queued' }, { ...f, readPidStart: () => 'start' });
    expect(readDrainRedTeamEvidence({ ...f, isAlive: () => true, readPidStart: () => 'start' })).toMatchObject({ scheduled: true, queued: true, inFlight: false, recorded: false });
    expect(redTeamEnqueueHold({ ...f, ...readDrainRedTeamEvidence(f), comments: [] })).toMatch(/no recorded result/);
    // A crashed job leaves a dead writer: still held, but not a live queue entry that blocks the deadline escape.
    const dead = readDrainRedTeamEvidence({ ...f, isAlive: () => false });
    expect(dead).toMatchObject({ scheduled: true, inFlight: false });
    expect(dead.queued).toBeUndefined();
  });
  // PR #5482 self-review: the review job and the drain resolve WE_RED_TEAM_SKIP_CARD_ONLY in separate processes.
  it('carries the writer\'s card-only skip decision to the drain, whatever the drain process resolves', () => {
    const f = fixture();
    const cardOnly = { ...payload(f.head), findings: { read: { netBasis: { rev: f.head }, netChangedFiles: ['backlog/123-card.md'], netRenameSources: [] } } };
    const live = { ...f, isAlive: () => true, readPidStart: () => 'start' };
    recordRedTeamStatus({ ...f, loopPayload: cardOnly, status: 'queued' }, { ...f, env: { WE_RED_TEAM_TIMING: 'post-accept', ...f.env, WE_RED_TEAM_SKIP_CARD_ONLY: 'false' }, readPidStart: () => 'start' });
    expect(readDrainRedTeamEvidence(live).skipCardOnly).toBe(false);
    expect(redTeamEnqueueHold({ ...f, ...readDrainRedTeamEvidence(live), comments: [] })).toMatch(/no recorded result/);
    recordRedTeamStatus({ ...f, loopPayload: cardOnly, status: 'queued' }, { ...f, env: { WE_RED_TEAM_TIMING: 'post-accept', ...f.env, WE_RED_TEAM_SKIP_CARD_ONLY: 'true' }, readPidStart: () => 'start' });
    expect(redTeamEnqueueHold({ ...f, ...readDrainRedTeamEvidence(live), env: { WE_RED_TEAM_TIMING: 'post-accept', WE_RED_TEAM_SKIP_CARD_ONLY: 'false' }, comments: [] })).toBeNull();
  });
  it('holds a card-only run until the job records its skip decision, then honours that decision', () => {
    const f = fixture();
    const read = { netBasis: { rev: f.head }, netChangedFiles: ['backlog/123-card.md'], netRenameSources: [] };
    writeRun({ ...newRunRecord({ id: 'review-pr-5439', op: 'review-pr', input: { repo: f.repo, pr: f.pr } }), verdict: { verdict: 'accept' }, findings: { read } }, f.runsDir);
    // No job status yet: only the job knows its card-only decision, so the head is held (main's guard).
    expect(readDrainRedTeamEvidence(f).skipCardOnly).toBe(false);
    expect(redTeamEnqueueHold({ ...f, ...readDrainRedTeamEvidence(f), env: { WE_RED_TEAM_TIMING: 'post-accept', WE_RED_TEAM_SKIP_CARD_ONLY: 'true' }, comments: [] })).not.toBeNull();
    recordRedTeamStatus({ ...f, loopPayload: { verdict: { verdict: 'accept' }, findings: { read } }, status: 'queued' }, { ...f, env: { WE_RED_TEAM_TIMING: 'post-accept', ...f.env, WE_RED_TEAM_SKIP_CARD_ONLY: 'true' }, readPidStart: () => 'start' });
    expect(redTeamEnqueueHold({ ...f, ...readDrainRedTeamEvidence({ ...f, isAlive: () => true, readPidStart: () => 'start' }), comments: [] })).toBeNull();
  });
  it('keeps a pre-normalization status record held', () => {
    const f = { ...fixture(), repo: 'Web-Everything/Web-Everything', head: 'B'.repeat(40) };
    recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'running' }, f);
    const canonical = join(redTeamStatusDir(f.env), `${encodeURIComponent(f.repo.toLowerCase())}-${f.pr}-${f.head.toLowerCase()}.json`);
    const legacy = join(redTeamStatusDir(f.env), `${encodeURIComponent(f.repo)}-${f.pr}-${f.head}.json`);
    renameSync(canonical, legacy);
    const evidence = readDrainRedTeamEvidence({ ...f, isAlive: () => false });
    expect(evidence).toMatchObject({ scheduled: true, attempted: true });
    expect(redTeamEnqueueHold({ ...f, ...evidence, comments: [] })).toMatch(/no recorded result/);
  });
  it('keeps a case-mismatched recorded attempt held', () => {
    const f = { ...fixture(), head: 'B'.repeat(40) };
    const rows = [{ dispatchKind: 'review-seat', seat: 'red-team', repo: f.repo, pr: f.pr, rev: f.head, status: 'unparseable' }];
    const evidence = readDrainRedTeamEvidence({ ...f, readScorecards: () => rows });
    expect(evidence).toMatchObject({ recorded: true, attempted: true });
    expect(redTeamEnqueueHold({ ...f, ...evidence, comments: [] })).toMatch(/no recorded result/);
  });
  it('keeps an errored attempt held when a newer accepting review exists', () => {
    const f = fixture();
    recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'finished', result: 'error' }, f);
    const path = join(redTeamStatusDir(f.env), `${encodeURIComponent(f.repo)}-${f.pr}-${f.head}.json`);
    utimesSync(path, new Date(0), new Date(0));
    writeRun({ ...newRunRecord({ id: 'review-pr-newer', op: 'review-pr', input: { repo: f.repo, pr: f.pr } }), ...payload(f.head) }, f.runsDir);
    expect(readDrainRedTeamEvidence(f)).toMatchObject({ scheduled: true, attempted: true });
  });
  it('does not mistake a reused pid for the original red-team process', () => {
    const f = fixture();
    recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'running' }, { ...f, readPidStart: () => 'original-start' });
    expect(readDrainRedTeamEvidence({ ...f, isAlive: () => true, readPidStart: () => 'original-start' }).inFlight).toBe(true);
    expect(readDrainRedTeamEvidence({ ...f, isAlive: () => true, readPidStart: () => 'reused-start' }).inFlight).toBe(false);
  });
  it.each([
    [{ host: 'review-host' }, { host: 'drain-host' }],
    [{ host: 'same-host', namespace: 'pid:[review]' }, { host: 'same-host', namespace: 'pid:[drain]' }],
  ])('does not waive a process outside the local pid table', (writer, reader) => {
    const f = fixture();
    recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'running' }, { ...f, ...writer, readPidStart: () => 'start' });
    expect(readDrainRedTeamEvidence({ ...f, ...reader, isAlive: () => false }).inFlight).toBe(true);
    recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'finished', result: 'ran' }, { ...f, ...writer });
    expect(readDrainRedTeamEvidence({ ...f, ...reader, isAlive: () => false })).toMatchObject({ inFlight: false, recorded: true });
  });
  it('preserves local liveness when the birth-time probe is unavailable or metadata is legacy', () => {
    const f = fixture();
    recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'running' }, { ...f, readPidStart: () => 'start' });
    expect(readDrainRedTeamEvidence({ ...f, isAlive: () => true, readPidStart: () => null }).inFlight).toBe(true);
    const path = join(redTeamStatusDir(f.env), `${encodeURIComponent(f.repo)}-${f.pr}-${f.head}.json`);
    const status = JSON.parse(readFileSync(path, 'utf8'));
    delete status.host;
    delete status.pidStart;
    delete status.pidNamespace;
    writeFileSync(path, JSON.stringify(status));
    expect(readDrainRedTeamEvidence({ ...f, isAlive: () => true }).inFlight).toBe(true);
    expect(readDrainRedTeamEvidence({ ...f, isAlive: () => false }).inFlight).toBe(false);
  });
  it('reads a bounded process birth-time probe and treats failures as unknown', () => {
    expect(pidStartTime(42, (cmd, args, opts) => {
      expect(cmd).toBe('ps');
      expect(args).toEqual(['-p', '42', '-o', 'lstart=']);
      expect(opts).toMatchObject({ timeout: 5000, maxBuffer: 4096, env: { WE_RED_TEAM_TIMING: 'post-accept', LC_ALL: 'C', TZ: 'UTC' } });
      return '  Fri Oct 16 12:34:56 2026\n';
    })).toBe('Fri Oct 16 12:34:56 2026');
    expect(pidStartTime(42, () => { throw new Error('unavailable'); })).toBeNull();
    expect(pidStartTime(42, () => '  ')).toBeNull();
    expect(pidStartTime(-1, () => { throw new Error('must not execute'); })).toBeNull();
  });
  it('reads the persisted review payload and rejects stale heads, other PRs and repos', () => {
    const f = fixture();
    const run = { ...newRunRecord({ id: 'review-pr-5439', op: 'review-pr', input: { repo: f.repo, pr: f.pr } }), ...payload(f.head) };
    writeRun(run, f.runsDir);
    expect(readDrainRedTeamEvidence(f)).toMatchObject({ loopPayload: run, recorded: false, inFlight: false });
    for (const mismatch of [{ head: 'a'.repeat(40) }, { pr: 5443 }, { repo: 'other/repo' }]) {
      expect(readDrainRedTeamEvidence({ ...f, ...mismatch }).loopPayload).toBeNull();
    }
  });
  it('honors an existing seat row even when the result comment was never posted', () => {
    const f = fixture();
    const row = { dispatchKind: 'review-seat', seat: 'red-team', repo: f.repo, pr: f.pr, rev: f.head, status: 'ok' };
    expect(readDrainRedTeamEvidence({ ...f, readScorecards: () => [row] }).recorded).toBe(true);
    for (const mismatch of [{ rev: 'a'.repeat(40) }, { repo: 'other/repo' }, { pr: 5443 }, { dispatchKind: 'review-seat-speculative-discard' }]) {
      expect(readDrainRedTeamEvidence({ ...f, readScorecards: () => [{ ...row, ...mismatch }] }).recorded).toBe(false);
    }
  });
  it('a skipped provider pass is not evidence that a red team ran', () => {
    const f = fixture();
    recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'finished', result: 'skipped' }, f);
    expect(readDrainRedTeamEvidence(f)).toMatchObject({ recorded: false, inFlight: false });
  });
  it('observes running, crashed and finished passes across reader restarts', () => {
    const f = fixture();
    recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'running' }, f);
    expect(readDrainRedTeamEvidence({ ...f, isAlive: () => true })).toMatchObject({ recorded: false, inFlight: true });
    expect(readDrainRedTeamEvidence({ ...f, isAlive: () => false })).toMatchObject({ recorded: false, inFlight: false });
    expect(readDrainRedTeamEvidence({ ...f, head: 'a'.repeat(40) })).toMatchObject({ recorded: false, inFlight: false });
    recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'finished', result: 'ran' }, f);
    expect(readDrainRedTeamEvidence({ ...f, isAlive: () => true })).toMatchObject({ recorded: true, inFlight: false });
  });
});

it('replays #5461 saved and posted old-head breaks without treating them as live-head work', () => {
  const f = { ...fixture(), pr: 5461, head: 'ff45ed96c40644e5537370df84b6b30328b1a73e' };
  const oldHead = '4752c275333c66228ea55c4b6d65f4038c760d38';
  const findings = [{ summary: 'old break', confirmedByRecheck: true, impactIfUnfixed: 'broken', category: 'security' }];
  const row = { dispatchKind: 'review-seat', seat: 'red-team', repo: f.repo, pr: f.pr, rev: oldHead,
    status: 'ok', recheckStatus: 'ok', confirmedMissCount: 1, findings };
  const path = resolveScorecardStorePath(f.env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, records: [row] }));
  saveProvenanceFixtures(f.env);
  recordRedTeamStatus({ ...f, loopPayload: payload(oldHead), status: 'finished', result: { status: 'ran' } }, f);
  const evidence = readDrainRedTeamEvidence({ ...f, readScorecards: () => [row] });
  expect(evidence).toMatchObject({ loopPayload: null, scheduled: false, attempted: false, recorded: false, inFlight: false });
  const comments = [{ author: { login: 'web-everything' }, body: renderRedTeamComment({ pr: f.pr, rev: oldHead, findings, recheckStatus: 'ok' }) }];
  expect(redTeamEnqueueHold({ ...f, ...evidence, comments, requestPending: true })).toBe('post-accept red team has no recorded result on the live head');
  expect(redTeamEnqueueHold({ ...f, ...evidence, comments, head: oldHead })).toContain('requiring send-back');
});

// Live #5608: a speculative red team wrote `running`, the review never accepted (prevention-outstanding), and the
// pass was discarded without finishing its record. The dead record read as an attempted pass forever and kept
// `red-team:pending` on a PR no red team was owed on. The reader now marks such a record `overNotOwed` for the label
// planner ONLY; every scheduling/attempt field the drain's merge hold reads is unchanged.
describe('a red-team record that is provably over and never owed clears the label, never the merge hold', () => {
  const timed = (f, timing) => ({ ...f, env: { ...f.env, WE_RED_TEAM_TIMING: timing } });
  const notAccepted = head => ({ verdict: { verdict: 'prevention-outstanding' }, findings: { read: { netBasis: { rev: head } } } });
  const statusFileOf = f => join(redTeamStatusDir(f.env), `${encodeURIComponent(f.repo)}-${f.pr}-${f.head}.json`);
  function seed(f, verdictPayload, { status = 'running', result = null, ageMin = 120 } = {}) {
    writeRun({ ...newRunRecord({ id: 'review-pr-5608', op: 'review-pr', input: { repo: f.repo, pr: f.pr } }), ...verdictPayload }, f.runsDir);
    const runAt = new Date(Date.now() - (ageMin + 1) * 60_000);
    utimesSync(join(f.runsDir, 'review-pr-5608.json'), runAt, runAt);
    recordRedTeamStatus({ ...f, loopPayload: { findings: { read: { netBasis: { rev: f.head } } } }, status, result }, f);
    const at = new Date(Date.now() - ageMin * 60_000);
    utimesSync(statusFileOf(f), at, at);
  }
  const plan = (f, evidence, labels) => planRedTeamStatusLabels({ labels, comments: [], repo: f.repo, pr: f.pr, head: f.head, evidence, env: f.env, savedResult: null });
  it.each(['panel-seat', 'post-accept'])('#5608 shape (%s): a dead `running` past the TTL on a non-accepting head drops red-team:pending', timing => {
    const f = timed(fixture(), timing);
    seed(f, notAccepted(f.head));
    const evidence = readDrainRedTeamEvidence({ ...f, isAlive: () => false });
    expect(evidence).toMatchObject({ overNotOwed: true, inFlight: false, attempted: true });
    expect(plan(f, evidence, ['red-team:pending'])).toEqual({ add: null, remove: ['red-team:pending'] });
  });
  it('a dead `running` younger than the TTL is not marked over (unchanged)', () => {
    const f = timed(fixture(), 'panel-seat');
    seed(f, notAccepted(f.head), { ageMin: 5 });
    const evidence = readDrainRedTeamEvidence({ ...f, isAlive: () => false });
    expect(evidence.overNotOwed).toBeUndefined();
    expect(plan(f, evidence, []).add).toBe('red-team:pending');
  });
  it.each(['panel-seat', 'post-accept'])('(%s) a human-accepted head over a non-accepting run keeps its merge hold and its pending label', timing => {
    const f = timed(fixture(), timing);
    seed(f, notAccepted(f.head));
    const before = readDrainRedTeamEvidence({ ...f, isAlive: () => false, now: () => 0 });
    const evidence = readDrainRedTeamEvidence({ ...f, isAlive: () => false });
    // Merge-relevant fields are identical with and without the TTL having passed.
    const { overNotOwed, ...rest } = evidence;
    expect(rest).toEqual(before);
    expect(redTeamEnqueueHold({ ...f, ...evidence, labels: ['review:accepted'], comments: [] })).toMatch(/no recorded result/);
    expect(plan(f, evidence, ['review:accepted', 'red-team:pending']).remove).not.toContain('red-team:pending');
  });
  it('a dead `running` past the TTL on an ACCEPTING head is not marked over and keeps every hold', () => {
    const f = timed(fixture(), 'panel-seat');
    seed(f, payload(f.head));
    const evidence = readDrainRedTeamEvidence({ ...f, isAlive: () => false });
    expect(evidence.overNotOwed).toBeUndefined();
    expect(evidence).toMatchObject({ attempted: true, scheduled: true });
    expect(redTeamEnqueueHold({ ...f, ...evidence, comments: [] })).toMatch(/no recorded result/);
  });
  it('a LIVE `running` pass past the TTL still counts as running and is not marked over', () => {
    const f = timed(fixture(), 'panel-seat');
    seed(f, notAccepted(f.head));
    const evidence = readDrainRedTeamEvidence({ ...f, isAlive: () => true, readPidStart: () => pidStartTime(process.pid) });
    expect(evidence).toMatchObject({ inFlight: true, scheduled: true });
    expect(evidence.overNotOwed).toBeUndefined();
  });
  it('a `running` record from another host past the TTL still counts as running', () => {
    const f = timed(fixture(), 'panel-seat');
    seed(f, notAccepted(f.head));
    const evidence = readDrainRedTeamEvidence({ ...f, host: 'some-other-host', isAlive: () => false });
    expect(evidence).toMatchObject({ inFlight: true });
    expect(evidence.overNotOwed).toBeUndefined();
  });
  it('a `not-owed` finish on a non-accepting head under panel-seat timing drops the pending label', () => {
    const f = timed(fixture(), 'panel-seat');
    seed(f, notAccepted(f.head), { status: 'finished', result: 'not-owed', ageMin: 0 });
    const evidence = readDrainRedTeamEvidence({ ...f, isAlive: () => false });
    expect(evidence.overNotOwed).toBe(true);
    expect(plan(f, evidence, ['red-team:pending'])).toEqual({ add: null, remove: ['red-team:pending'] });
  });
});
