// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newRunRecord, writeRun } from '../../operations/run-store.mjs';
import { historicalCardOnlySkipCandidate, readDrainRedTeamEvidence, recordRedTeamStatus, readRedTeamStatus, redTeamStatusDir } from '../drain-red-team-evidence.mjs';
import { redTeamEnqueueHold } from '../drain-queue-safety.mjs';
import { redTeamOwedFor } from '../review-red-team-policy.mjs';
import { pidStartTime } from '../pid-alive.mjs';
import { resumeRedTeamCarry } from '../red-team-carry-machine.mjs';

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

describe('historical fallback predicate clauses', () => {
  const evidence = () => ({ status: { status: 'finished', skipCardOnly: true, result: 'skipped' },
    recorded: false, inFlight: false, queued: false });
  it('accepts a finished unrecorded policy skip', () => {
    expect(historicalCardOnlySkipCandidate(evidence())).toBe(true);
  });
  it.each([
    ['finished status', e => { e.status.status = 'running'; }],
    ['historical policy', e => { e.status.skipCardOnly = false; }],
    ['skipped result', e => { e.status.result = 'ran'; }],
    ['no recorded seat', e => { e.recorded = true; }],
    ['not in flight', e => { e.inFlight = true; }],
    ['not queued', e => { e.queued = true; }],
  ])('independently requires %s', (_clause, mutate) => {
    const old = evidence();
    mutate(old);
    expect(historicalCardOnlySkipCandidate(old)).toBe(false);
  });
});

describe('drain reads actual head-bound review scheduler inputs', () => {
  it.each(['failed', { status: 'failed' }])('holds a failed red-team result with no scorecard row after append failure: %j', result => {
    const f = fixture();
    recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'finished', result }, f);
    const evidence = readDrainRedTeamEvidence(f);
    expect(evidence).toMatchObject({ recorded: false, seatRecorded: false, completedRecorded: false,
      failedSeatCount: 0, inFlight: false, status: { status: 'finished', result } });
    expect(redTeamEnqueueHold({ ...f, ...evidence, comments: [] })).toMatch(/no recorded result/);
    expect(evidence.scheduled).toBe(true);
  });

  it.each(['missing status', 'real panel status', 'same-head panel', 'different-head panel'])(
    'unfinished journal discovery handles %s without manufacturing a verdict', kind => {
      const f = fixture(), from = 'a'.repeat(40);
      const loopPayload = { verdict: null, carriedFrom: from, findings: { read: {
        netBasis: { rev: f.head }, diffText: '+card', netChangedFiles: ['backlog/123-card.md'],
      } } };
      // Power loss immediately after the journal rename, before the compatibility status.
      expect(() => resumeRedTeamCarry({ ...f, loopPayload }, { env: f.env, eligible: () => true,
        intentRecorded: () => false, recordIntent: () => { throw Error('crash'); },
      })).toThrow('crash');
      if (kind === 'real panel status') {
        recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'finished', result: 'ran' }, f);
      } else if (kind.includes('panel')) {
        writeRun({ ...newRunRecord({ id: 'review-pr-later-panel', op: 'review-pr', input: { repo: f.repo, pr: f.pr } }),
          ...payload(kind === 'same-head panel' ? f.head : 'c'.repeat(40)) }, f.runsDir);
      }
      const evidence = readDrainRedTeamEvidence(f);
      if (kind === 'missing status') {
        expect(evidence).toMatchObject({ carry: { step: 'intent' }, loopPayload: { verdict: null },
          status: { status: 'finished', result: { status: 'skipped', policy: 'card-only' } } });
      } else {
        expect(evidence.carryConflict).toBe(true);
        expect(evidence.carry).toBeUndefined();
      }
    });
  it.each(['accept', 'changes'])('a carried %s verdict is never exposed as a live-head panel verdict', verdict => {
    const f = fixture(), carriedFrom = 'c'.repeat(40);
    const loopPayload = { ...payload(f.head), carriedFrom, verdict: { verdict } };
    recordRedTeamStatus({ ...f, loopPayload, status: 'finished', result: { status: 'skipped', policy: 'card-only' } }, f);
    const evidence = readDrainRedTeamEvidence(f);
    expect(evidence.loopPayload).toMatchObject({ carriedFrom, verdict: null,
      findings: { read: { netBasis: { rev: f.head } } } });
    expect(redTeamOwedFor(evidence.loopPayload)).toBe(false);
    expect(evidence.status.loopPayload.verdict).toEqual({ verdict });
    expect(loopPayload.verdict).toEqual({ verdict });
  });
  it('preserves spent retry admission through running and finished writes, including an explicit zero', () => {
    const f = fixture(), loopPayload = payload(f.head);
    recordRedTeamStatus({ ...f, loopPayload, status: 'queued', retryCount: 1 }, { env: f.env });
    recordRedTeamStatus({ ...f, loopPayload, status: 'running' }, { env: f.env });
    expect(readRedTeamStatus(f).retryCount).toBe(1);
    recordRedTeamStatus({ ...f, loopPayload, status: 'finished', result: 'ran', retryCount: 0 }, { env: f.env });
    expect(readRedTeamStatus(f).retryCount).toBe(1);
  });
  it('refuses an existing retry marker even after stale status restoration, and isolates heads', () => {
    const f = fixture(), loopPayload = payload(f.head);
    recordRedTeamStatus({ ...f, loopPayload, status: 'finished', result: 'ran' }, { env: f.env });
    const path = join(redTeamStatusDir(f.env), `${encodeURIComponent(f.repo)}-${f.pr}-${f.head}.json`);
    const stale = readFileSync(path, 'utf8');
    recordRedTeamStatus({ ...f, loopPayload, status: 'queued', retryCount: 1 }, { env: f.env });
    writeFileSync(path, stale);
    expect(() => recordRedTeamStatus({ ...f, loopPayload, status: 'queued', retryCount: 1 }, { env: f.env }))
      .toThrow('retry already admitted');
    expect(readFileSync(path, 'utf8')).toBe(stale);
    recordRedTeamStatus({ ...f, loopPayload, status: 'running' }, { env: f.env });
    expect(readRedTeamStatus(f).retryCount).toBe(1);
    const other = { ...f, head: 'c'.repeat(40) };
    recordRedTeamStatus({ ...other, loopPayload: payload(other.head), status: 'queued', retryCount: 1 }, { env: f.env });
    expect(readRedTeamStatus(other).retryCount).toBe(1);
  });

  it('keeps the retry spent when status persistence fails after the exclusive create', () => {
    const f = fixture(), loopPayload = payload(f.head);
    expect(() => recordRedTeamStatus({ ...f, loopPayload, status: 'queued', retryCount: 1 },
      { env: f.env, readPidStart: () => { throw Error('injected metadata failure'); } })).toThrow('injected metadata failure');
    // Readers fail closed on the orphaned marker; the writer below must still record the settlement.
    expect(() => readRedTeamStatus(f)).toThrow('red-team retry marker has no status');
    expect(() => recordRedTeamStatus({ ...f, loopPayload, status: 'queued', retryCount: 1 }, { env: f.env }))
      .toThrow('retry already admitted');
    recordRedTeamStatus({ ...f, loopPayload, status: 'finished', retryCount: 0 }, { env: f.env });
    expect(readRedTeamStatus(f).retryCount).toBe(1);
  });

  it('refuses historical spent retry counts without a marker', () => {
    const f = fixture(), loopPayload = payload(f.head);
    recordRedTeamStatus({ ...f, loopPayload, status: 'finished' }, { env: f.env });
    const path = join(redTeamStatusDir(f.env), `${encodeURIComponent(f.repo)}-${f.pr}-${f.head}.json`);
    writeFileSync(path, JSON.stringify({ ...readRedTeamStatus(f), retryCount: 1 }));
    expect(() => recordRedTeamStatus({ ...f, loopPayload, status: 'queued', retryCount: 1 }, { env: f.env }))
      .toThrow('retry already admitted');
  });

  describe('only the owning, still-queued admission refunds its retry', () => {
    const statusFile = f => join(redTeamStatusDir(f.env), `${encodeURIComponent(f.repo)}-${f.pr}-${f.head}.json`);
    const admit = (f, loopPayload) => recordRedTeamStatus({ ...f, loopPayload, status: 'queued', retryCount: 1 }, { env: f.env });
    const settle = (f, loopPayload, input = {}, opts = {}) =>
      recordRedTeamStatus({ ...f, loopPayload, status: 'finished', result: 'ran', refundRetry: true, ...input }, { env: f.env, ...opts });

    it('the owning queued admission refunds: the marker goes and a later admission is accepted', () => {
      const f = fixture(), loopPayload = payload(f.head);
      admit(f, loopPayload);
      settle(f, loopPayload);
      expect(existsSync(`${statusFile(f)}.retry-1`)).toBe(false);
      expect(readRedTeamStatus(f).retryCount).toBeUndefined();
      expect(() => admit(f, loopPayload)).not.toThrow();
    });

    it.each([
      ['a prior status record', (f, lp) => {
        // An orphaned marker: the admission's status write never landed.
        admit(f, lp);
        rmSync(statusFile(f));
        return {};
      }],
      ['a queued (not running) prior', (f, lp) => {
        admit(f, lp);
        recordRedTeamStatus({ ...f, loopPayload: lp, status: 'running' }, { env: f.env });
        return {};
      }],
      ['a queued (not finished) prior', (f, lp) => {
        admit(f, lp);
        recordRedTeamStatus({ ...f, loopPayload: lp, status: 'finished', result: 'ran' }, { env: f.env });
        return {};
      }],
      ['a prior that spent the retry', (f, lp) => {
        admit(f, lp);
        const path = statusFile(f);
        writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), retryCount: 2 }));
        return {};
      }],
      ['refundRetry === true (not merely truthy 1)', (f, lp) => { admit(f, lp); return { input: { refundRetry: 1 } }; }],
      ["refundRetry === true (not merely truthy 'true')", (f, lp) => { admit(f, lp); return { input: { refundRetry: 'true' } }; }],
      ['no retryCount on the refunding write', (f, lp) => { admit(f, lp); return { input: { retryCount: 0 } }; }],
      ['the owning pid', (f, lp) => {
        admit(f, lp);
        const path = statusFile(f);
        writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), pid: process.pid + 1 }));
        return {};
      }],
      ['the owning process start time (a reused pid)', (f, lp) => {
        admit(f, lp);
        const path = statusFile(f);
        writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), pidStart: 'an-earlier-process' }));
        return {};
      }],
      ['the owning host', (f, lp) => { admit(f, lp); return { opts: { host: 'another-host' } }; }],
      ['the owning pid namespace', (f, lp) => { admit(f, lp); return { opts: { namespace: 'another-namespace' } }; }],
    ])('refuses to refund without %s, and the retry stays spent', (_clause, arrange) => {
      const f = fixture(), loopPayload = payload(f.head);
      const { input, opts } = arrange(f, loopPayload);
      settle(f, loopPayload, input, opts);
      expect(existsSync(`${statusFile(f)}.retry-1`)).toBe(true);
      expect(readRedTeamStatus(f).retryCount).toBeGreaterThanOrEqual(1);
      expect(() => admit(f, loopPayload)).toThrow('retry already admitted');
    });

    it('a crash after the refund removed the marker still counts the queued retry as spent', () => {
      const f = fixture(), loopPayload = payload(f.head);
      admit(f, loopPayload);
      // The ownership check reads the start time; the status write's read then crashes.
      let reads = 0;
      const readPidStart = pid => { if (++reads > 1) throw Error('crash after refund'); return pidStartTime(pid); };
      expect(() => settle(f, loopPayload, {}, { readPidStart })).toThrow('crash after refund');
      expect(existsSync(`${statusFile(f)}.retry-1`)).toBe(false);
      expect(readRedTeamStatus(f)).toMatchObject({ status: 'queued', retryCount: 1 });
      expect(() => admit(f, loopPayload)).toThrow('retry already admitted');
    });
  });

  it.each(['queued', 'running', 'finished', 'fresh retry', 'refund'].flatMap(kind => [
    [kind, 'truncated JSON', '{broken'],
    [kind, 'null JSON', 'null'],
    [kind, 'wrong identity', JSON.stringify({ repo: 'another/repo', pr: 5439, head: 'b'.repeat(40) })],
    [kind, 'malformed PR identity', JSON.stringify({ repo: 'web-everything/web-everything',
      pr: { toString: null, valueOf: null }, head: 'b'.repeat(40) })],
  ]))('%s writes repair %s only when no retry marker exists', (kind, _damage, contents) => {
    const f = fixture(), loopPayload = payload(f.head);
    recordRedTeamStatus({ ...f, loopPayload, status: 'queued' }, { env: f.env });
    const path = join(redTeamStatusDir(f.env), `${encodeURIComponent(f.repo)}-${f.pr}-${f.head}.json`);
    writeFileSync(path, contents);
    expect(() => readRedTeamStatus(f)).toThrow();
    const status = kind === 'fresh retry' ? 'queued' : kind === 'refund' ? 'finished' : kind;
    recordRedTeamStatus({ ...f, loopPayload, status,
      ...(kind === 'fresh retry' ? { retryCount: 1 } : {}),
      ...(kind === 'refund' ? { refundRetry: true } : {}),
    }, { env: f.env });
    expect(readRedTeamStatus(f)).toMatchObject({ repo: f.repo, pr: f.pr, head: f.head, status });
    expect(readRedTeamStatus(f).retryCount).toBe(kind === 'fresh retry' ? 1 : undefined);
    expect(existsSync(`${path}.retry-1`)).toBe(kind === 'fresh retry');
  });

  it.each(['queued', 'running', 'finished', 'fresh retry', 'refund'].flatMap(kind => [
    [kind, 'truncated JSON', '{broken'],
    [kind, 'null JSON', 'null'],
    [kind, 'wrong identity', JSON.stringify({ repo: 'another/repo', pr: 5439, head: 'b'.repeat(40) })],
    [kind, 'malformed PR identity', JSON.stringify({ repo: 'web-everything/web-everything',
      pr: { toString: null, valueOf: null }, head: 'b'.repeat(40) })],
  ]))('%s writes preserve %s beside a retry marker for operator inspection', (kind, _damage, contents) => {
    const f = fixture(), loopPayload = payload(f.head);
    recordRedTeamStatus({ ...f, loopPayload, status: 'queued', retryCount: 1 }, { env: f.env });
    const path = join(redTeamStatusDir(f.env), `${encodeURIComponent(f.repo)}-${f.pr}-${f.head}.json`);
    writeFileSync(path, contents);
    const status = kind === 'fresh retry' ? 'queued' : kind === 'refund' ? 'finished' : kind;
    expect(() => recordRedTeamStatus({ ...f, loopPayload, status,
      ...(kind === 'fresh retry' ? { retryCount: 1 } : {}),
      ...(kind === 'refund' ? { refundRetry: true } : {}),
    }, { env: f.env })).toThrow();
    expect(readFileSync(path, 'utf8')).toBe(contents);
    expect(existsSync(`${path}.retry-1`)).toBe(true);
  });

  it.each([-1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1])(
    'never repairs a valid head-bound record with invalid retryCount %j', retryCount => {
      const f = fixture(), loopPayload = payload(f.head);
      recordRedTeamStatus({ ...f, loopPayload, status: 'queued' }, { env: f.env });
      const path = join(redTeamStatusDir(f.env), `${encodeURIComponent(f.repo)}-${f.pr}-${f.head}.json`);
      const contents = JSON.stringify({ ...readRedTeamStatus(f), retryCount });
      writeFileSync(path, contents);
      expect(() => recordRedTeamStatus({ ...f, loopPayload, status: 'running' }, { env: f.env }))
        .toThrow('invalid red-team retry count');
      expect(readFileSync(path, 'utf8')).toBe(contents);
    });

  it('refuses to overwrite unreadable retry evidence so an operator can inspect it', () => {
    const f = fixture(), loopPayload = payload(f.head);
    recordRedTeamStatus({ ...f, loopPayload, status: 'queued', retryCount: 1 }, { env: f.env });
    const path = join(redTeamStatusDir(f.env), `${encodeURIComponent(f.repo)}-${f.pr}-${f.head}.json`);
    writeFileSync(path, '{broken');
    expect(() => recordRedTeamStatus({ ...f, loopPayload, status: 'running' }, { env: f.env })).toThrow();
    expect(readFileSync(path, 'utf8')).toBe('{broken');
  });

  it('does not invent an accept when no review run exists', () => {
    expect(readDrainRedTeamEvidence(fixture())).toEqual({ loopPayload: null, recorded: false,
      seatRecorded: false, completedRecorded: false, failedSeatCount: 0, scheduled: false, inFlight: false });
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
  it.each([
    [{ status: 'ok', foldedVerdict: 'changes', confirmedMissCount: 1 }, true],
    [{ status: 'error' }, false],
    [{ status: 'ok', seatStatus: 'error' }, false],
  ])('separates an existing seat from a completed execution: %j', (fields, completedRecorded) => {
    const f = fixture();
    const row = { dispatchKind: 'review-seat', seat: 'red-team', repo: f.repo, pr: f.pr, rev: f.head, ...fields };
    expect(readDrainRedTeamEvidence({ ...f, readScorecards: () => [row] }))
      .toMatchObject({ recorded: true, seatRecorded: true, completedRecorded });
  });
  it('a review-pr string ran cannot substitute for an actual completed seat', () => {
    const f = fixture();
    recordRedTeamStatus({ ...f, loopPayload: { ...payload(f.head), op: 'review-pr' }, status: 'finished', result: 'ran' }, f);
    expect(readDrainRedTeamEvidence(f)).toMatchObject({ seatRecorded: false, completedRecorded: false });
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


it('surfaces a finished old card-only skip when the live head has no read', () => {
  const f = fixture(), oldHead = 'b'.repeat(40);
  f.head = 'a'.repeat(40);
  const loopPayload = { verdict: { verdict: 'changes' }, findings: { read: {
    netBasis: { rev: oldHead }, netChangedFiles: ['backlog/123-card.md'], diffText: '+card',
  } } };
  writeRun({ ...newRunRecord({ id: 'review-pr-old-card', op: 'review-pr', input: { repo: f.repo, pr: f.pr } }),
    ...loopPayload, stepTimings: [{ step: 'read', stepIndex: 0, startedAt: new Date(1000).toISOString() }] }, f.runsDir);
  recordRedTeamStatus({ ...f, loopPayload, status: 'finished', result: 'skipped' }, f);
  expect(readDrainRedTeamEvidence(f)).toMatchObject({ loopPayload, recorded: false, seatRecorded: false,
    status: { status: 'finished', head: oldHead, skipCardOnly: true } });
  // The exact live-head read always wins over this historical fallback.
  writeRun({ ...newRunRecord({ id: 'review-pr-live', op: 'review-pr', input: { repo: f.repo, pr: f.pr } }),
    ...payload(f.head), stepTimings: [{ step: 'read', stepIndex: 0, startedAt: new Date(2000).toISOString() }] }, f.runsDir);
  expect(readDrainRedTeamEvidence(f).loopPayload.findings.read.netBasis.rev).toBe(f.head);
});

it.each(['non-card read', 'missing read paths', 'non-card rename source', 'skipCardOnly false',
  'skipCardOnly missing', 'recorded seat', 'live-head seat', 'running', 'queued', 'not skipped', 'missing status'])(
  'historical fallback refuses %s and returns no live-head read', variant => {
    const f = fixture(), oldHead = 'c'.repeat(40);
    const loopPayload = { verdict: { verdict: 'changes' }, findings: { read: {
      netBasis: { rev: oldHead }, netChangedFiles: ['backlog/123-card.md'], diffText: '+card',
    } } };
    if (variant === 'non-card read') loopPayload.findings.read.netChangedFiles = ['scripts/code.mjs'];
    if (variant === 'missing read paths') delete loopPayload.findings.read.netChangedFiles;
    if (variant === 'non-card rename source') loopPayload.findings.read.netRenameSources = ['scripts/code.mjs'];
    writeRun({ ...newRunRecord({ id: 'review-pr-old-card-negative', op: 'review-pr', input: { repo: f.repo, pr: f.pr } }),
      ...loopPayload }, f.runsDir);
    if (variant !== 'missing status') {
      recordRedTeamStatus({ ...f, loopPayload, status: 'finished', result: 'skipped' }, f);
      const path = join(redTeamStatusDir(f.env), `${encodeURIComponent(f.repo)}-${f.pr}-${oldHead}.json`);
      const status = JSON.parse(readFileSync(path, 'utf8'));
      if (variant === 'skipCardOnly false') status.skipCardOnly = false;
      if (variant === 'skipCardOnly missing') delete status.skipCardOnly;
      if (['running', 'queued'].includes(variant)) status.status = variant;
      if (variant === 'not skipped') status.result = 'error';
      writeFileSync(path, JSON.stringify(status));
    }
    const hasSeat = ['recorded seat', 'live-head seat'].includes(variant);
    const evidence = readDrainRedTeamEvidence({ ...f, isAlive: () => true, readPidStart: () => null,
      readScorecards: () => hasSeat ? [{ dispatchKind: 'review-seat', seat: 'red-team', repo: f.repo,
        pr: f.pr, rev: variant === 'live-head seat' ? f.head : oldHead }] : [] });
    expect(evidence).toEqual({ loopPayload: null, recorded: variant === 'live-head seat',
      seatRecorded: variant === 'live-head seat', completedRecorded: false,
      failedSeatCount: variant === 'live-head seat' ? 1 : 0, scheduled: variant === 'live-head seat', inFlight: false });
  });

it.each([['unparseable', 1, false], ['error', 1, false], ['ok', 0, true]])(
  'counts failed %s seats only for the exact repo/PR/head', (status, failedSeatCount, completedRecorded) => {
    const f = fixture();
    const row = { dispatchKind: 'review-seat', seat: 'red-team', repo: f.repo, pr: f.pr, rev: f.head, status };
    f.readScorecards = () => [row, { ...row, rev: 'a'.repeat(40) }, { ...row, repo: 'another/repo' }];
    expect(readDrainRedTeamEvidence(f)).toMatchObject({ failedSeatCount, completedRecorded, seatRecorded: true });
  });

import { readRecoveryWitness, RUN_MTIME_SLACK_MS } from '../drain-red-team-evidence.mjs';
import { MAX_RUN_RECORDS_PARSED } from '../stream-filter-runs.mjs';
describe('bounded review evidence scans', () => {
  // Records 10 s apart by mtime. A record is written after its read step starts, so its mtime bounds that start.
  const big = { list: () => Array.from({ length: 5000 }, (_, i) => `review-pr-${i}`),
    stat: path => ({ mtimeMs: Number(path.match(/review-pr-(\d+)/)[1]) * 10_000 }) };
  const startedAt = ms => ({ stepTimings: [{ step: 'read', startedAt: new Date(ms).toISOString() }] });
  it.each([['drain', readDrainRedTeamEvidence], ['recovery', readRecoveryWitness]])('%s resolves the newest finished exact-head run among 5000 records without reaching the cap', (_name, reader) => {
    const f = fixture();
    let reads = 0;
    const run = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(f.head), ...startedAt(4999 * 10_000 - 1000) };
    const result = reader({ ...f, ...big, read: id => { reads++; return id === 'review-pr-4999' ? run : null; } });
    expect(result.ok).not.toBe(false);
    expect(result.newest ?? result.loopPayload).toEqual(run);
    expect(reads).toBe(1);
  });
  it.each([['drain', readDrainRedTeamEvidence], ['recovery', readRecoveryWitness]])('%s stops as soon as no unscanned record can have started after the match', (_name, reader) => {
    const f = fixture();
    let reads = 0;
    // The match started 35 s before its own last write, so the three newer-by-mtime records must be read first.
    const run = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(f.head), ...startedAt(4996 * 10_000 - 1000) };
    const result = reader({ ...f, ...big, read: id => { reads++; return id === 'review-pr-4996' ? run : null; } });
    expect(result.newest ?? result.loopPayload).toEqual(run);
    expect(reads).toBe(4);
  });
  it.each([['drain', readDrainRedTeamEvidence], ['recovery', readRecoveryWitness]])('%s holds when the newest exact-head match lies outside the parse window', (_name, reader) => {
    const f = fixture();
    let reads = 0;
    const run = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(f.head), ...startedAt(0) };
    const result = reader({ ...f, ...big, read: id => { reads++; return id === 'review-pr-0' ? run : null; } });
    expect(result).toMatchObject({ ok: false, reason: 'scan-capped' });
    expect(reads).toBe(MAX_RUN_RECORDS_PARSED);
  });
  it.each([['drain', readDrainRedTeamEvidence], ['recovery', readRecoveryWitness]])('%s holds a match touched late whose old start cannot rule out the omitted records', (_name, reader) => {
    const f = fixture();
    let reads = 0;
    const run = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(f.head), ...startedAt(1000) };
    const result = reader({ ...f, ...big, read: id => { reads++; return id === 'review-pr-4999' ? run : null; } });
    expect(result).toMatchObject({ ok: false, reason: 'scan-capped' });
    expect(redTeamEnqueueHold({ ...f, ...result, comments: [] })).toMatch(/scan-capped/);
    expect(reads).toBe(MAX_RUN_RECORDS_PARSED);
  });
  it.each([['drain', readDrainRedTeamEvidence], ['recovery', readRecoveryWitness]])('%s still holds for a newer unfinished re-review found before the early stop', (_name, reader) => {
    const f = fixture();
    const accepted = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(f.head), ...startedAt(4998 * 10_000 - 1000) };
    const unfinished = { ...accepted, verdict: null, pending: { kind: 'judge' }, effects: [], ...startedAt(4999 * 10_000 - 1000) };
    const result = reader({ ...f, ...big, read: id => ({ 'review-pr-4999': unfinished, 'review-pr-4998': accepted })[id] ?? null });
    expect(result).toMatchObject({ ok: false, reason: 'review-unfinished' });
  });
  const statusFile = f => join(redTeamStatusDir(f.env), `${encodeURIComponent(f.repo)}-${f.pr}-${f.head}.json`);
  it('drain resolves a carried head among 5000 records when the carried-from review is the newest run', () => {
    const f = fixture(), from = 'c'.repeat(40);
    recordRedTeamStatus({ ...f, loopPayload: { ...payload(f.head), carriedFrom: from }, status: 'finished', result: 'skipped' }, f);
    const panel = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(from), ...startedAt(4999 * 10_000 - 1000) };
    let reads = 0;
    const result = readDrainRedTeamEvidence({ ...f, ...big, read: id => { reads++; return id === 'review-pr-4999' ? panel : null; } });
    expect(result.ok).not.toBe(false);
    expect(result).toMatchObject({ status: { status: 'finished' } });
    expect(reads).toBe(MAX_RUN_RECORDS_PARSED);
  });
  it('drain still reports a later panel that invalidates a carry among 5000 records', () => {
    const f = fixture(), from = 'c'.repeat(40);
    recordRedTeamStatus({ ...f, loopPayload: { ...payload(f.head), carriedFrom: from }, status: 'finished', result: 'skipped' }, f);
    const later = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload('d'.repeat(40)), ...startedAt(4999 * 10_000 - 1000) };
    const result = readDrainRedTeamEvidence({ ...f, ...big, read: id => id === 'review-pr-4999' ? later : null });
    expect(result).toMatchObject({ carryConflict: true, loopPayload: later });
  });
  it('drain holds a carried head when the newest same-PR run cannot be settled inside the window', () => {
    const f = fixture(), from = 'c'.repeat(40);
    recordRedTeamStatus({ ...f, loopPayload: { ...payload(f.head), carriedFrom: from }, status: 'finished', result: 'skipped' }, f);
    const panel = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(from), ...startedAt(1000) };
    const result = readDrainRedTeamEvidence({ ...f, ...big, read: id => id === 'review-pr-4999' ? panel : null });
    expect(result).toMatchObject({ ok: false, reason: 'scan-capped' });
  });
  it('drain holds an uncarried status head whose exact-head review the window omitted', () => {
    const f = fixture();
    recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'finished', result: 'ran' }, f);
    // The newest run reviewed another head; the head's own review (and any re-review after it) lies past the cap.
    const other = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload('d'.repeat(40)), ...startedAt(4999 * 10_000 - 1000) };
    const result = readDrainRedTeamEvidence({ ...f, ...big, read: id => id === 'review-pr-4999' ? other : null });
    expect(result).toMatchObject({ ok: false, reason: 'scan-capped' });
  });
  it('drain holds a status written before records the window omitted', () => {
    const f = fixture(), from = 'c'.repeat(40);
    recordRedTeamStatus({ ...f, loopPayload: { ...payload(f.head), carriedFrom: from }, status: 'finished', result: 'skipped' }, f);
    // The omitted records were written after the status, so a newer exact-head accept could hide among them.
    utimesSync(statusFile(f), 1, 1);
    const panel = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(from), ...startedAt(4999 * 10_000 - 1000) };
    const result = readDrainRedTeamEvidence({ ...f, ...big, read: id => id === 'review-pr-4999' ? panel : null });
    expect(result).toMatchObject({ ok: false, reason: 'scan-capped' });
  });
  // The first unread record (review-pr-4699) has mtime 46_990_000 ms. Both sides are mtimes, so a
  // status stamped in the same coarse tick, or within the slack after it, cannot prove the order.
  it.each([0, RUN_MTIME_SLACK_MS - 1])('drain holds a status stamped %i ms after the first omitted record', offset => {
    const f = fixture(), from = 'c'.repeat(40);
    recordRedTeamStatus({ ...f, loopPayload: { ...payload(f.head), carriedFrom: from }, status: 'finished', result: 'skipped' }, f);
    const at = new Date(4699 * 10_000 + offset);
    utimesSync(statusFile(f), at, at);
    const panel = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(from), ...startedAt(4999 * 10_000 - 1000) };
    const result = readDrainRedTeamEvidence({ ...f, ...big, read: id => id === 'review-pr-4999' ? panel : null });
    expect(result).toMatchObject({ ok: false, reason: 'scan-capped' });
  });
  it('drain resolves a carried head whose status was stamped the full slack after the first omitted record', () => {
    const f = fixture(), from = 'c'.repeat(40);
    recordRedTeamStatus({ ...f, loopPayload: { ...payload(f.head), carriedFrom: from }, status: 'finished', result: 'skipped' }, f);
    const at = new Date(4699 * 10_000 + RUN_MTIME_SLACK_MS);
    utimesSync(statusFile(f), at, at);
    const panel = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(from), ...startedAt(4999 * 10_000 - 1000) };
    const result = readDrainRedTeamEvidence({ ...f, ...big, read: id => id === 'review-pr-4999' ? panel : null });
    expect(result.ok).not.toBe(false);
    expect(result).toMatchObject({ status: { status: 'finished' } });
  });
  it.each([['drain', readDrainRedTeamEvidence], ['recovery', readRecoveryWitness]])('%s holds an unreviewed head: absence of an exact-head run cannot be proven past the cap', (_name, reader) => {
    const f = fixture();
    const older = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload('d'.repeat(40)), ...startedAt(4999 * 10_000 - 1000) };
    const result = reader({ ...f, ...big, read: id => id === 'review-pr-4999' ? older : null });
    expect(result).toMatchObject({ ok: false, reason: 'scan-capped' });
  });
  it.each([['drain', readDrainRedTeamEvidence], ['recovery', readRecoveryWitness]])('%s explicitly holds beyond the parse cap, including fallback scans', (_name, reader) => {
    const f = fixture();
    let reads = 0;
    const result = reader({ ...f, list: () => Array.from({ length: 5000 }, (_, i) => `review-pr-${i}`),
      stat: path => ({ mtimeMs: Number(path.match(/review-pr-(\d+)/)[1]) }),
      read: () => { reads++; return null; } });
    expect(result).toMatchObject({ ok: false, reason: 'scan-capped' });
    expect(redTeamEnqueueHold({ ...f, ...result, comments: [] })).toMatch(/scan-capped/);
    expect(reads).toBe(MAX_RUN_RECORDS_PARSED);
  });
});

it.each([
  ['drain preserves ascending id ties below the cap', readDrainRedTeamEvidence, 'review-pr-a', 3],
  ['recovery preserves descending id ties below the cap', readRecoveryWitness, 'review-pr-b', 3],
])('%s', (_name, reader, expectedId, expectedReads) => {
  const f = fixture();
  const runs = {
    'review-pr-a': { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(f.head),
      stepTimings: [{ step: 'read', startedAt: new Date(1000).toISOString() }] },
    'review-pr-b': { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(f.head), verdict: { verdict: 'changes' },
      stepTimings: [{ step: 'read', startedAt: new Date(1000).toISOString() }] },
    'review-pr-c': { op: 'review-pr', input: { repo: 'other', pr: f.pr }, ...payload(f.head) },
  };
  let reads = 0;
  const result = reader({ ...f, list: () => Object.keys(runs), stat: () => ({ mtimeMs: 1 }), read: id => { reads++; return runs[id]; } });
  expect(result.newest ?? result.loopPayload).toEqual(runs[expectedId]);
  expect(reads).toBe(expectedReads);
});

import { planRedTeamRecovery, planRedTeamOnSkip } from '../review-red-team-on-skip.mjs';
describe('fail-closed run scan evidence', () => {
  it.each([['drain', readDrainRedTeamEvidence], ['recovery', readRecoveryWitness]])('%s throws on a corrupt or unreadable record inside the scan window', (_name, reader) => {
    const f = fixture();
    expect(() => reader({ ...f, list: () => ['review-pr-a', 'review-pr-b'], stat: () => ({ mtimeMs: 1 }),
      read: id => { if (id === 'review-pr-b') throw Error('torn run'); return { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(f.head) }; } })).toThrow('torn run');
  });
  it.each([['drain', readDrainRedTeamEvidence], ['recovery', readRecoveryWitness]])('%s lets a logically newer unfinished re-review win even when the finished run has a newer mtime', (_name, reader) => {
    const f = fixture();
    const completed = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(f.head),
      stepTimings: [{ step: 'read', startedAt: new Date(1000).toISOString() }] };
    const unfinished = { ...completed, verdict: null, stepTimings: [{ step: 'read', startedAt: new Date(2000).toISOString() }] };
    const result = reader({ ...f, list: () => ['review-pr-completed', 'review-pr-unfinished'],
      stat: path => ({ mtimeMs: path.includes('completed') ? 4000 : 3000 }), read: id => id.includes('completed') ? completed : unfinished });
    expect(result).toMatchObject({ ok: false, reason: 'review-unfinished' });
    expect(redTeamEnqueueHold({ ...f, ...result, comments: [] })).toMatch(/unfinished/);
  });
  it('holds a finished writer when the cap prevents excluding an unfinished re-review', () => {
    const f = fixture();
    recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'finished', result: 'ran' }, f);
    const result = readDrainRedTeamEvidence({ ...f, list: () => Array.from({ length: 5000 }, (_, i) => `review-pr-${i}`),
      stat: () => ({ mtimeMs: 1 }), read: () => null });
    expect(result).toMatchObject({ ok: false, reason: 'scan-capped' });
    expect(redTeamEnqueueHold({ ...f, ...result, comments: [], recorded: true })).toMatch(/scan-capped/);
  });
  it('uses the configured scan bound in both evidence paths', () => {
    const f = fixture();
    const platformPath = join(f.runsDir, '..', 'platform.json');
    writeFileSync(platformPath, JSON.stringify({ runs: { scan: { maxParses: 2 } } }));
    // Inject a tool settings block to leave the operator platform preference in control.
    for (const reader of [readDrainRedTeamEvidence, readRecoveryWitness]) {
      let reads = 0;
      const result = reader({ ...f, scanSettings: { file: {}, env: { WE_PLATFORM_PREFERENCES_FILE: platformPath } },
        list: () => ['review-pr-a', 'review-pr-b', 'review-pr-c'], stat: () => ({ mtimeMs: 1 }),
        read: () => { reads++; return null; } });
      expect(result).toMatchObject({ ok: false, reason: 'scan-capped' });
      expect(reads).toBe(2);
    }
  });
  it('recovery and skipped-PR scheduling explicitly refuse capped evidence', () => {
    expect(planRedTeamRecovery({ ok: false, reason: 'scan-capped' })).toMatchObject({ mode: 'skip', why: 'scan-capped' });
    const f = fixture();
    const rows = planRedTeamOnSkip({ repo: f.repo, refusals: [{ kind: 'already-reviewed-head', prNumber: f.pr }],
      rawPrs: [{ number: f.pr, headRefOid: f.head, comments: [], labels: ['review:accepted'] }],
      readEvidence: () => ({ ok: false, reason: 'scan-capped' }), readStatus: () => null,
      setting: { enabled: true }, lastDispatch: new Map(), now: 0 });
    expect(rows[0]).toMatchObject({ action: 'skip', why: 'scan-capped' });
  });
  it.each(['scan-capped', 'review-unfinished', 'run-start-missing'])('skipped-PR scheduling skips one PR on a %s witness instead of reading its writer', reason => {
    const f = fixture();
    let evidenceReads = 0;
    const rows = planRedTeamOnSkip({ repo: f.repo, refusals: [{ kind: 'already-reviewed-head', prNumber: f.pr }],
      rawPrs: [{ number: f.pr, headRefOid: f.head, comments: [], labels: ['review:accepted'] }],
      readWitness: () => ({ ok: false, reason }), readEvidence: () => { evidenceReads++; return {}; }, readStatus: () => null,
      setting: { enabled: true }, lastDispatch: new Map(), now: 0 });
    expect(rows[0]).toMatchObject({ action: 'skip', why: reason });
    expect(evidenceReads).toBe(0);
  });
});

import { planRedTeamStatusLabels } from '../red-team-status-labels.mjs';
it('capped evidence replaces a stale clear label with pending instead of preserving clearance', () => {
  const f = fixture();
  expect(planRedTeamStatusLabels({ ...f, labels: ['red-team:clear'], comments: [],
    evidence: { ok: false, reason: 'scan-capped' } })).toEqual({ add: 'red-team:pending', remove: ['red-team:clear'] });
});
it('an older unfinished review does not replace a logically newer finished panel', () => {
  const f = fixture();
  const completed = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(f.head),
    stepTimings: [{ step: 'read', startedAt: new Date(2000).toISOString() }] };
  const unfinished = { ...completed, verdict: null, stepTimings: [{ step: 'read', startedAt: new Date(1000).toISOString() }] };
  const result = readDrainRedTeamEvidence({ ...f, list: () => ['review-pr-completed', 'review-pr-unfinished'],
    stat: path => ({ mtimeMs: path.includes('completed') ? 4000 : 3000 }), read: id => id.includes('completed') ? completed : unfinished });
  expect(result.ok).not.toBe(false);
  expect(result.loopPayload).toEqual(completed);
});

describe('readRecoveryWitness carryEvidence shares the scan but keeps the drain tie order', () => {
  it('recovery fallback shares the total parse budget', () => {
    const f = fixture();
    let reads = 0;
    const other = { op: 'review-pr', input: { repo: f.repo, pr: f.pr + 1 }, ...payload(f.head) };
    const result = readRecoveryWitness({ ...f, list: () => Array.from({ length: 200 }, (_, i) => `review-pr-${i}`),
      stat: path => ({ mtimeMs: Number(path.match(/review-pr-(\d+)/)[1]) }), read: () => { reads++; return other; } });
    expect(result.newest).toBeNull();
    expect(result.carryEvidence).toBeDefined();
    expect(reads).toBe(200);
  });
  it('the drain fallback breaks equal starts by ascending id, unlike recovery', () => {
    const f = fixture(), from = 'c'.repeat(40);
    recordRedTeamStatus({ ...f, loopPayload: { ...payload(f.head), carriedFrom: from }, status: 'finished', result: 'skipped' }, f);
    const start = { stepTimings: [{ step: 'read', startedAt: new Date(1000).toISOString() }] };
    // Ascending id selects the carried-from panel; descending would select the later-head panel (a carry conflict).
    const runs = { 'review-pr-a': { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(from), ...start },
      'review-pr-b': { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload('d'.repeat(40)), ...start } };
    let reads = 0;
    const args = { ...f, list: () => Object.keys(runs), stat: () => ({ mtimeMs: 5000 }), read: id => { reads++; return runs[id]; } };
    expect(readDrainRedTeamEvidence(args).carryConflict).toBeFalsy();
    reads = 0;
    const witness = readRecoveryWitness(args);
    expect(witness.carryEvidence.carryConflict).toBeFalsy();
    expect(reads).toBe(2);
  });
});

describe('abandoned and start-less review runs have a defined outcome', () => {
  const started = ms => ({ stepTimings: [{ step: 'read', startedAt: new Date(ms).toISOString() }] });
  const HOUR = 60 * 60 * 1000;
  const both = [['drain', readDrainRedTeamEvidence], ['recovery', readRecoveryWitness]];
  const setup = (f, other, otherAt) => {
    const accepted = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(f.head), pending: null, effects: [], ...started(10_000) };
    const runs = { 'review-pr-accepted': accepted, 'review-pr-other': other(accepted) };
    return { accepted, args: { ...f, list: () => Object.keys(runs), read: id => runs[id],
      stat: path => ({ mtimeMs: path.includes('other') ? otherAt : 12_000 }) } };
  };
  it.each(both)('%s ignores a start-less record written before the selected run started', (_name, reader) => {
    const f = fixture();
    // A record that predates stepTimings: its last write precedes the accepted run's read start.
    const { accepted, args } = setup(f, a => ({ op: 'review-pr', input: a.input, ...payload(f.head), verdict: { verdict: 'changes' } }), 5_000);
    const result = reader(args);
    expect(result.ok).not.toBe(false);
    expect(result.newest ?? result.loopPayload).toEqual(accepted);
  });
  it.each(both)('%s holds a recent start-less record that may have started after the selected run', (_name, reader) => {
    const f = fixture();
    const { args } = setup(f, a => ({ op: 'review-pr', input: a.input, verdict: null, pending: null, effects: [], findings: {} }), 20_000);
    expect(reader({ ...args, now: 20_000 + 60_000 })).toEqual({ ok: false, reason: 'run-start-missing' });
  });
  it.each(both)('%s ignores a run that crashed before its read step once it is abandoned', (_name, reader) => {
    const f = fixture();
    const { accepted, args } = setup(f, a => ({ op: 'review-pr', input: a.input, verdict: null, pending: null, effects: [], findings: {} }), 20_000);
    const result = reader({ ...args, now: 20_000 + HOUR });
    expect(result.ok).not.toBe(false);
    expect(result.newest ?? result.loopPayload).toEqual(accepted);
  });
  it.each(both)('%s holds a newer verdict-less run while it may still be live, then ignores it once abandoned', (_name, reader) => {
    const f = fixture();
    const { accepted, args } = setup(f, a => ({ ...a, verdict: null, ...started(15_000) }), 20_000);
    expect(reader({ ...args, now: 20_000 + 60_000 })).toEqual({ ok: false, reason: 'review-unfinished' });
    const result = reader({ ...args, now: 20_000 + HOUR });
    expect(result.ok).not.toBe(false);
    expect(result.newest ?? result.loopPayload).toEqual(accepted);
  });
  // Each non-verdict clause of the unfinished check, alone: the newer run already carries a verdict,
  // so only its pending step or pending/in-flight effect can hold it (a verdict-null fixture would mask them).
  const withWork = [['a pending step', { pending: { kind: 'judge' } }], ['a pending effect', { effects: [{ status: 'pending' }] }],
    ['an in-flight effect', { effects: [{ status: 'in-flight' }] }]];
  it.each(both.flatMap(([name, reader]) => withWork.map(([what, work]) => [name, what, reader, work])))(
    '%s holds a verdict-bearing newer run with %s as review-unfinished', (_name, _what, reader, work) => {
      const f = fixture();
      const { args } = setup(f, a => ({ ...a, verdict: { verdict: 'accept' }, ...work, ...started(15_000) }), 20_000);
      expect(reader({ ...args, now: 20_000 + 60_000 })).toEqual({ ok: false, reason: 'review-unfinished' });
      expect(reader({ ...args, now: 20_000 + 30 * 24 * HOUR })).toEqual({ ok: false, reason: 'review-unfinished' });
    });
  it.each(both)('%s selects the same verdict-bearing newer run once nothing is pending (control)', (_name, reader) => {
    const f = fixture();
    const { args } = setup(f, a => ({ ...a, verdict: { verdict: 'accept' }, pending: null, effects: [{ status: 'applied' }], ...started(15_000) }), 20_000);
    const result = reader({ ...args, now: 20_000 + 60_000 });
    expect(result.ok).not.toBe(false);
    expect((result.newest ?? result.loopPayload).stepTimings).toEqual(started(15_000).stepTimings);
  });
  it.each(both)('%s never treats a run still waiting on a pending step or effect as abandoned', (_name, reader) => {
    const f = fixture();
    for (const waiting of [{ pending: { kind: 'judge' } }, { effects: [{ status: 'in-flight' }] }]) {
      const { args } = setup(f, a => ({ ...a, verdict: null, ...waiting, ...started(15_000) }), 20_000);
      expect(reader({ ...args, now: 20_000 + 30 * 24 * HOUR })).toEqual({ ok: false, reason: 'review-unfinished' });
    }
  });
  it.each(both)('%s never treats a rewound resume the review loop may still finish as abandoned', (_name, reader) => {
    const f = fixture();
    // rewindRunToStep clears verdict and pending but keeps the read start; the loop marks it resumeOf.
    const { args } = setup(f, a => ({ ...a, verdict: null, resumeOf: { attempts: 1 }, ...started(15_000) }), 20_000);
    expect(reader({ ...args, now: 20_000 + 30 * 24 * HOUR })).toEqual({ ok: false, reason: 'review-unfinished' });
  });
  it.each(both)('%s keeps an older stale verdict-less run from blocking a newer finished accept', (_name, reader) => {
    const f = fixture();
    const { accepted, args } = setup(f, a => ({ ...a, verdict: null, ...started(1_000) }), 2_000);
    const result = reader({ ...args, now: 20_000 });
    expect(result.ok).not.toBe(false);
    expect(result.newest ?? result.loopPayload).toEqual(accepted);
  });
});

describe('review ordering uses persisted run start time', () => {
  const started = ms => ({ stepTimings: [{ step: 'read', startedAt: new Date(ms).toISOString() }] });
  it.each([['drain', readDrainRedTeamEvidence], ['recovery', readRecoveryWitness]])('%s selects a newer rejection over an older acceptance touched later', (_name, reader) => {
    const f = fixture();
    const older = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(f.head), ...started(1000) };
    const newer = { ...older, verdict: { verdict: 'changes' }, ...started(2000) };
    const result = reader({ ...f, list: () => ['review-pr-older', 'review-pr-newer'],
      stat: path => ({ mtimeMs: path.endsWith('review-pr-older.json') ? 4000 : 3000 }), read: id => id.includes('older') ? older : newer });
    expect(result.newest ?? result.loopPayload).toEqual(newer);
  });
  it.each([['drain', readDrainRedTeamEvidence], ['recovery', readRecoveryWitness]])('%s holds when either of two same-PR runs lacks a parseable start timestamp', (_name, reader) => {
    const f = fixture();
    const base = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(f.head) };
    for (const [missing, invalidStart] of [
      ['review-pr-a', {}], ['review-pr-b', {}],
      ['review-pr-a', { stepTimings: [{ step: 'read', startedAt: 'not-a-date' }] }],
    ]) {
      const result = reader({ ...f, list: () => ['review-pr-a', 'review-pr-b'], stat: () => ({ mtimeMs: 1 }),
        read: id => id === missing ? { ...base, ...invalidStart } : { ...base, ...started(2000) } });
      expect(result).toEqual({ ok: false, reason: 'run-start-missing' });
      expect(redTeamEnqueueHold({ ...f, ...result, comments: [] })).toMatch(/run-start-missing/);
    }
  });
  it.each([['drain', readDrainRedTeamEvidence], ['recovery', readRecoveryWitness]])('%s still accepts a single run without a timestamp because no ordering is needed', (_name, reader) => {
    const f = fixture();
    const run = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(f.head) };
    const result = reader({ ...f, list: () => ['review-pr-single'], stat: () => ({ mtimeMs: 1 }), read: () => run });
    expect(result.ok).not.toBe(false);
    expect(result.newest ?? result.loopPayload).toEqual(run);
  });
  it('uses the newer start time for the any-head selection that invalidates a carry', () => {
    const f = fixture(), from = 'c'.repeat(40), laterHead = 'd'.repeat(40);
    recordRedTeamStatus({ ...f, loopPayload: { ...payload(f.head), carriedFrom: from }, status: 'finished', result: 'skipped' }, f);
    const older = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(from), ...started(1000) };
    const newer = { ...older, ...payload(laterHead), verdict: { verdict: 'changes' }, ...started(2000) };
    const result = readDrainRedTeamEvidence({ ...f, list: () => ['review-pr-older', 'review-pr-newer'],
      stat: path => ({ mtimeMs: path.endsWith('review-pr-older.json') ? 4000 : 3000 }), read: id => id.includes('older') ? older : newer });
    expect(result).toMatchObject({ carryConflict: true, loopPayload: newer });
  });
});

it.each([['drain', readDrainRedTeamEvidence, 'review-pr-a'], ['recovery', readRecoveryWitness, 'review-pr-b']])('%s breaks equal start times by its existing id order, never by mtime', (_name, reader, expectedId) => {
  const f = fixture();
  const runs = Object.fromEntries(['review-pr-a', 'review-pr-b'].map(id => [id, {
    op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(f.head),
    verdict: { verdict: id === 'review-pr-a' ? 'accept' : 'changes' },
    stepTimings: [{ step: 'read', startedAt: new Date(1000).toISOString() }],
  }]));
  const result = reader({ ...f, list: () => Object.keys(runs),
    stat: path => ({ mtimeMs: path.includes(expectedId) ? 3000 : 4000 }), read: id => runs[id] });
  expect(result.newest ?? result.loopPayload).toEqual(runs[expectedId]);
});
