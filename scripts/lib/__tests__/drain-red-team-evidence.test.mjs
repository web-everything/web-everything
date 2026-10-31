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
      seatRecorded: false, completedRecorded: false, completedRow: null, seatRows: [], failedSeatCount: 0, scheduled: false, inFlight: false });
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
    ...loopPayload }, f.runsDir);
  recordRedTeamStatus({ ...f, loopPayload, status: 'finished', result: 'skipped' }, f);
  expect(readDrainRedTeamEvidence(f)).toMatchObject({ loopPayload, recorded: false, seatRecorded: false,
    status: { status: 'finished', head: oldHead, skipCardOnly: true } });
  // The exact live-head read always wins over this historical fallback.
  writeRun({ ...newRunRecord({ id: 'review-pr-live', op: 'review-pr', input: { repo: f.repo, pr: f.pr } }),
    ...payload(f.head) }, f.runsDir);
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
      seatRecorded: variant === 'live-head seat', completedRecorded: false, completedRow: null,
      seatRows: variant === 'live-head seat' ? [{ dispatchKind: 'review-seat', seat: 'red-team', repo: f.repo, pr: f.pr, rev: f.head }] : [],
      failedSeatCount: variant === 'live-head seat' ? 1 : 0, scheduled: variant === 'live-head seat', inFlight: false });
  });

it.each([['unparseable', 1, false], ['error', 1, false], ['ok', 0, true]])(
  'counts failed %s seats only for the exact repo/PR/head', (status, failedSeatCount, completedRecorded) => {
    const f = fixture();
    const row = { dispatchKind: 'review-seat', seat: 'red-team', repo: f.repo, pr: f.pr, rev: f.head, status };
    f.readScorecards = () => [row, { ...row, rev: 'a'.repeat(40) }, { ...row, repo: 'another/repo' }];
    expect(readDrainRedTeamEvidence(f)).toMatchObject({ failedSeatCount, completedRecorded, seatRecorded: true });
  });
