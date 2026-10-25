// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newRunRecord, writeRun } from '../../operations/run-store.mjs';
import { readDrainRedTeamEvidence, recordRedTeamStatus, redTeamStatusDir } from '../drain-red-team-evidence.mjs';
import { redTeamEnqueueHold } from '../drain-queue-safety.mjs';
import { pidStartTime } from '../pid-alive.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'drain-red-team-'));
  roots.push(root);
  const runsDir = join(root, 'runs');
  return { repo: 'web-everything/web-everything', pr: 5439, head: 'b'.repeat(40), runsDir,
    readScorecards: () => [], env: { WE_SHARED_RUNS_DIR: runsDir } };
}
const payload = head => ({ verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev: head } } } });

describe('drain reads actual head-bound review scheduler inputs', () => {
  it('does not invent an accept when no review run exists', () => {
    expect(readDrainRedTeamEvidence(fixture())).toEqual({ loopPayload: null, recorded: false, scheduled: false, inFlight: false });
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
    expect(redTeamEnqueueHold({ ...f, ...readDrainRedTeamEvidence({ ...f, env: { ...f.env, WE_REVIEW_RED_TEAM: 'off' } }), comments: [] })).toBeNull();
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
  it('a newer accepting run does not hide a finished but unpublished result on the same head', () => {
    const f = fixture();
    const result = { status: 'ran', foldedVerdict: 'changes', comment: 'withheld', findings: [] };
    recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'finished', result }, f);
    utimesSync(join(redTeamStatusDir(f.env), `${encodeURIComponent(f.repo)}-${f.pr}-${f.head}.json`), new Date(1_000_000), new Date(1_000_000));
    writeRun({ ...newRunRecord({ id: 'review-pr-3', op: 'review-pr', input: { repo: f.repo, pr: f.pr } }), ...payload(f.head) }, f.runsDir);
    expect(readDrainRedTeamEvidence(f).status?.result?.comment).toBe('withheld');
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
    recordRedTeamStatus({ ...f, loopPayload: cardOnly, status: 'queued' }, { ...f, env: { ...f.env, WE_RED_TEAM_SKIP_CARD_ONLY: 'false' }, readPidStart: () => 'start' });
    expect(readDrainRedTeamEvidence(live).skipCardOnly).toBe(false);
    expect(redTeamEnqueueHold({ ...f, ...readDrainRedTeamEvidence(live), comments: [] })).toMatch(/no recorded result/);
    recordRedTeamStatus({ ...f, loopPayload: cardOnly, status: 'queued' }, { ...f, env: { ...f.env, WE_RED_TEAM_SKIP_CARD_ONLY: 'true' }, readPidStart: () => 'start' });
    expect(redTeamEnqueueHold({ ...f, ...readDrainRedTeamEvidence(live), env: { WE_RED_TEAM_SKIP_CARD_ONLY: 'false' }, comments: [] })).toBeNull();
  });
  it('holds an owing card-only run until the job records its skip decision', () => {
    const f = fixture();
    const read = { netBasis: { rev: f.head }, netChangedFiles: ['backlog/123-card.md'], netRenameSources: [] };
    writeRun({ ...newRunRecord({ id: 'review-pr-5439', op: 'review-pr', input: { repo: f.repo, pr: f.pr } }), verdict: { verdict: 'accept' }, findings: { read } }, f.runsDir);
    expect(readDrainRedTeamEvidence(f).skipCardOnly).toBe(false);
    expect(redTeamEnqueueHold({ ...f, ...readDrainRedTeamEvidence(f), env: { WE_RED_TEAM_SKIP_CARD_ONLY: 'true' }, comments: [] })).toMatch(/no recorded result/);
    recordRedTeamStatus({ ...f, loopPayload: { verdict: { verdict: 'accept' }, findings: { read } }, status: 'queued' }, { ...f, env: { ...f.env, WE_RED_TEAM_SKIP_CARD_ONLY: 'true' }, readPidStart: () => 'start' });
    expect(redTeamEnqueueHold({ ...f, ...readDrainRedTeamEvidence({ ...f, isAlive: () => true, readPidStart: () => 'start' }), comments: [] })).toBeNull();
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
  it('reads a compact result object like the bare ran string', () => {
    const f = fixture();
    recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'finished', result: { status: 'ran', foldedVerdict: 'changes', comment: 'withheld' } }, f);
    expect(readDrainRedTeamEvidence({ ...f, isAlive: () => false })).toMatchObject({ scheduled: true, recorded: true });
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
      expect(opts).toMatchObject({ timeout: 5000, maxBuffer: 4096, env: { LC_ALL: 'C', TZ: 'UTC' } });
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
