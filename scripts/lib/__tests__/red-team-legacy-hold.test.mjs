// @vitest-environment node
// The stored red-team evidence for a head is the single authority for "is it held" (PR #6622, operator send-back).
// Everything below runs the REAL functions end to end: the real default seat-row reader (scorecard store), the real
// status file, the real sweep and the real hold decision behind readRedTeamDisposition. Nothing injects a seat row.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publishStoredRedTeamResult } from '../red-team-withheld-publish.mjs';
import { planRedTeamStatusLabels, syncRedTeamStatusLabels } from '../red-team-status-labels.mjs';
import { readRedTeamDisposition, redTeamHoldDecision, redTeamRulingNeeded, redTeamMarker } from '../red-team-gate.mjs';
import { readSealedStatus, sealedStatusPath } from '../red-team-sealed-status.mjs';
import { redTeamEnqueueHold } from '../drain-queue-safety.mjs';
import { recordRedTeamStatus } from '../drain-red-team-evidence.mjs';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
import { writeStore, resolveScorecardStorePath } from '../../conveyor/run-scorecard-store.mjs';
import { sweepAdvisoryLabels } from '../../conveyor/advisory-label-sweep.mjs';
import { SHARED_RUNS_DIR_ENV } from '../../operations/run-store.mjs';

const head = 'a'.repeat(40);
const repo = 'o/n';
const trusted = body => ({ author: { login: 'web-everything' }, body, createdAt: '2026-11-10T12:00:00Z' });
const clearComment = trusted(`${redTeamMarker(42, head)}\n### Post-accept red team — no break found`);
const brokenFinding = { summary: 'Confirmed boundary check bypass', file: 'scripts/x.mjs', line: 12,
  category: 'correctness', impactIfUnfixed: 'broken', confirmedByRecheck: true };
const otherFinding = { ...brokenFinding, summary: 'A different confirmed defect', file: 'scripts/y.mjs', line: 99 };
const seatRow = (extra = {}) => ({ dispatchKind: 'review-seat', seat: 'red-team', repo, pr: 42, rev: head,
  status: 'ok', provider: 'claude', model: 'test-model', callId: 'call-1', recheckStatus: 'ok',
  foldedVerdict: 'changes', confirmedMissCount: 1, findings: [brokenFinding], ...extra });
const legacyStatus = () => ({ repo, pr: 42, head, status: 'finished', result: 'ran' });
const render = (findings, rev = head) => trusted(renderRedTeamComment({ pr: 42, rev, provider: 'claude', model: 'test-model',
  findings, recheckStatus: 'ok', foldedVerdict: 'changes' }));

let dir;
const saved = {};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rt-hold-'));
  for (const k of ['CONVEYOR_STATE_ROOT', SHARED_RUNS_DIR_ENV]) saved[k] = process.env[k];
  process.env.CONVEYOR_STATE_ROOT = dir;
  process.env[SHARED_RUNS_DIR_ENV] = join(dir, 'runs');
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dir, { recursive: true, force: true });
});
const store = records => writeStore({ version: 1, records }, { path: resolveScorecardStorePath(process.env) });
const statusFile = () => sealedStatusPath({ repo, pr: 42, head }, process.env);
const writeStatusFile = status => { mkdirSync(join(statusFile(), '..'), { recursive: true }); writeFileSync(statusFile(), JSON.stringify(status)); };
const readStatusFile = () => JSON.parse(readFileSync(statusFile(), 'utf8'));

/** One REAL publisher run (default seat reader, default status IO) against a thread. */
function publish(comments, extra = {}) {
  const postComment = vi.fn();
  const publishNeedsYou = vi.fn();
  const out = publishStoredRedTeamResult({ status: readStatusFile(), listComments: () => comments, postComment, publishNeedsYou, ...extra });
  return { out, postComment, publishNeedsYou };
}
const heldBy = comments => readRedTeamDisposition({ comments, pr: 42, head, repo, env: process.env });
const prFor = comments => ({ number: 42, repo, headRefOid: head, comments, labels: ['review:human'] });

describe('(a) a seat row with a confirmed break plus a trusted "no break found" comment, one sweep pass', () => {
  it('plans red-team:blocked and never red-team:clear', () => {
    store([seatRow()]);
    writeStatusFile(legacyStatus());
    const setLabels = vi.fn();
    const labels = [{ name: 'red-team:pending' }];
    const provider = { currentRepo: () => repo, readComments: () => [clearComment], postComment: vi.fn(), ensureLabel: vi.fn(), setLabels };
    const results = sweepAdvisoryLabels({ repo, provider, log: () => {},
      listPrs: () => [{ number: 42, headRefOid: head, labels }],
      readPr: () => ({ number: 42, state: 'OPEN', labels, headRefOid: head, comments: [clearComment], reviews: [] }),
      // The pre-publish snapshot: it has neither the seal nor the hold the publish is about to record.
      readStatusEvidence: () => ({ status: readStatusFile() }),
      listUnpublishedStatuses: () => [readStatusFile()] });
    expect(results[0]).toMatchObject({ num: 42, publishStatus: 'held', add: 'red-team:blocked', remove: ['red-team:pending'] });
    expect(results[0].add).not.toBe('red-team:clear');
    expect(setLabels).toHaveBeenCalledWith(repo, 42, { add: 'red-team:blocked', remove: ['red-team:pending'] });
    expect(readStatusFile().sealedBreaks).toHaveLength(1);
  });
  it('an existing red-team:clear label is removed in the same pass', () => {
    store([seatRow()]);
    writeStatusFile(legacyStatus());
    const labels = [{ name: 'red-team:clear' }];
    const provider = { currentRepo: () => repo, readComments: () => [clearComment], postComment: vi.fn(), ensureLabel: vi.fn(), setLabels: vi.fn() };
    const [r] = sweepAdvisoryLabels({ repo, provider, log: () => {}, listPrs: () => [{ number: 42, headRefOid: head, labels }],
      readPr: () => ({ number: 42, state: 'OPEN', labels, headRefOid: head, comments: [clearComment], reviews: [] }),
      readStatusEvidence: () => ({ status: readStatusFile() }), listUnpublishedStatuses: () => [readStatusFile()] });
    expect(r).toMatchObject({ add: 'red-team:blocked', remove: ['red-team:clear'] });
  });
  it('the stale pre-publish snapshot alone never plans clear: the planner falls through to the stored seal', () => {
    store([seatRow()]);
    writeStatusFile(legacyStatus());
    const stale = readStatusFile();
    expect(publish([clearComment]).out).toEqual({ status: 'held' });
    const base = { repo, pr: 42, head, env: process.env, labels: ['red-team:pending'], comments: [clearComment] };
    expect(planRedTeamStatusLabels({ ...base, evidence: { status: stale } })).toEqual({ add: 'red-team:blocked', remove: ['red-team:pending'] });
    expect(syncRedTeamStatusLabels({ repo, pr: 42, head, evidence: { status: stale }, comments: [clearComment], dryRun: true,
      live: { headRefOid: head, labels: base.labels }, env: process.env, standingRuling: null, provider: {} }))
      .toEqual({ add: 'red-team:blocked', remove: ['red-team:pending'] });
  });
});

describe('(b)(c)(d) whole normalized bodies, never counts, markers or summaries', () => {
  it('(b) equal counts with different breaks are held', () => {
    store([seatRow()]);
    writeStatusFile(legacyStatus());
    const comments = [render([otherFinding])];
    expect(publish(comments).out).toEqual({ status: 'held' });
    expect(heldBy(comments).held.length).toBeGreaterThanOrEqual(1);
  });
  it('(c) a posted classBasis that differs from the stored break is held', () => {
    const classified = { ...brokenFinding, findingClass: 'security-reachable-today', classBasis: 'reproduced on the live head' };
    store([seatRow({ findings: [classified] })]);
    writeStatusFile(legacyStatus());
    const comments = [render([{ ...classified, classBasis: 'assumed' }])];
    expect(publish(comments).out).toEqual({ status: 'held' });
    expect(heldBy(comments).held.length).toBeGreaterThanOrEqual(1);
    // The identical rendering agrees: the same evidence is not held.
    const same = [render([classified])];
    expect(publish(same).out).toEqual({ status: 'skipped' });
    expect(heldBy(same).held).toHaveLength(0);
  });
  it('(c) the scenario text is part of the compared body', () => {
    const withScenario = { ...brokenFinding, failure_scenario: 'input A reaches B' };
    store([seatRow({ findings: [withScenario] })]);
    writeStatusFile(legacyStatus());
    expect(publish([render([{ ...withScenario, failure_scenario: 'something else' }])]).out).toEqual({ status: 'held' });
    expect(heldBy([render([{ ...withScenario, failure_scenario: 'something else' }])]).held.length).toBeGreaterThanOrEqual(1);
    // The hold lifts when the publisher next sees the identical rendering (it clears the alert flag it recorded).
    expect(publish([render([withScenario])]).out).toEqual({ status: 'skipped' });
    expect(heldBy([render([withScenario])]).held).toHaveLength(0);
  });
  it('(d) an existing marker comment is still validated against the stored breaks', () => {
    store([seatRow()]);
    writeStatusFile(legacyStatus());
    const markerOnly = trusted(redTeamMarker(42, head)); // a trusted marker with no findings at all
    expect(publish([markerOnly]).out).toEqual({ status: 'held' });
    expect(heldBy([markerOnly]).held.length).toBeGreaterThanOrEqual(1);
  });
  it('a lossy rendering of a stored break (blank file) cannot agree with an empty comment', () => {
    store([seatRow({ findings: [{ summary: 's', file: ' ', category: 'correctness', confirmedByRecheck: true }] })]);
    writeStatusFile(legacyStatus());
    expect(publish([clearComment]).out).toEqual({ status: 'held' });
    expect(heldBy([clearComment]).held.length).toBeGreaterThanOrEqual(1);
  });
  it('stored evidence with a break and NO posted comment holds too (the comment is what is missing)', () => {
    store([seatRow()]);
    writeStatusFile(legacyStatus());
    expect(publish([]).out).toEqual({ status: 'posted' });
    expect(heldBy([]).held.length).toBeGreaterThanOrEqual(1);
  });
  it('a comment can only add holds: a clean seal never lifts the comment\'s own break', () => {
    store([seatRow({ foldedVerdict: 'accept', confirmedMissCount: 0, findings: [] })]);
    writeStatusFile(legacyStatus());
    const comments = [render([brokenFinding])];
    publish(comments);
    expect(heldBy(comments).sendBack.length + heldBy(comments).held.length).toBeGreaterThanOrEqual(1);
  });
});

describe('the hold lifts only when the posted comment shows the SAME whole body', () => {
  it('an agreeing comment lifts the legacy flag and holds nothing', () => {
    store([seatRow()]);
    writeStatusFile({ ...legacyStatus(), legacyHoldPublished: true });
    const comments = [render([brokenFinding])];
    expect(publish(comments).out).toEqual({ status: 'skipped' });
    expect(readStatusFile().legacyHoldPublished).toBeUndefined();
    expect(heldBy(comments).held).toHaveLength(0);
  });
  it('a successful post of the recovered break drops the flag and agrees', () => {
    store([seatRow()]);
    writeStatusFile({ ...legacyStatus(), legacyHoldPublished: true });
    const r = publish([]);
    expect(r.out).toEqual({ status: 'posted' });
    expect(readStatusFile().legacyHoldPublished).toBeUndefined();
    const posted = trusted(r.postComment.mock.calls[0][0].body);
    expect(heldBy([posted]).held).toHaveLength(0);
  });
  it('unreadable legacy evidence keeps the flag hold (nothing to compare)', () => {
    store([]);
    writeStatusFile(legacyStatus());
    expect(publish([clearComment]).out).toEqual({ status: 'skipped' }); // posted comment stays authoritative, no alert
    expect(publish([]).out).toEqual({ status: 'held' });
    expect(heldBy([clearComment]).held.length).toBeGreaterThanOrEqual(1);
  });
});

describe('the sealed status reader fails closed', () => {
  it('reads the very file the drain evidence writer writes (path parity, with and without the runs-dir override)', () => {
    const loopPayload = { findings: { read: { netBasis: { rev: head } } } };
    recordRedTeamStatus({ repo, pr: 42, loopPayload, status: 'finished', result: 'ran' }, { env: process.env });
    expect(JSON.parse(readFileSync(sealedStatusPath({ repo, pr: 42, head }, process.env), 'utf8'))).toMatchObject({ repo, pr: 42, head, result: 'ran' });
    expect(sealedStatusPath({ repo, pr: 42, head }, {})).toBe(sealedStatusPath({ repo, pr: 42, head }, { [SHARED_RUNS_DIR_ENV]: '' }));
  });
  it('nothing sealed, a missing file and bad identity inputs hold nothing or fail closed', () => {
    expect(readSealedStatus({ repo, pr: 42, head, env: process.env })).toBeNull();
    expect(readSealedStatus({ repo: null, pr: 42, head })).toBeNull();
    expect(readSealedStatus({ repo, pr: 42, head: 'short' })).toBeNull();
    writeStatusFile({ ...legacyStatus(), sealedBreaks: [] });
    expect(readSealedStatus({ repo, pr: 42, head, env: process.env })).toEqual({ breaks: [], legacyHold: false });
  });
  it.each([
    ['a corrupt status file', () => writeFileSync(statusFile(), '{not json')],
    ['a malformed seal', () => writeStatusFile({ ...legacyStatus(), sealedBreaks: 'x' })],
    ['a status for another pr', () => writeStatusFile({ ...legacyStatus(), pr: 43, sealedBreaks: [] })],
  ])('%s is held, not ignored', (_name, setup) => {
    mkdirSync(join(statusFile(), '..'), { recursive: true });
    setup();
    expect(readSealedStatus({ repo, pr: 42, head, env: process.env })).toEqual({ unreadable: true });
    expect(heldBy([clearComment]).held.length).toBeGreaterThanOrEqual(1);
  });
  it('the pure decision: no seal holds nothing, an empty seal holds nothing, an unreadable seal holds', () => {
    expect(redTeamHoldDecision({ comments: [], pr: 42, head, sealed: null }).held).toBe(false);
    expect(redTeamHoldDecision({ comments: [], pr: 42, head, sealed: { breaks: [] } }).held).toBe(false);
    expect(redTeamHoldDecision({ comments: [], pr: 42, head, sealed: { unreadable: true } }).held).toBe(true);
  });
});

describe('the seal survives the rest of the pipeline (self-review round 1)', () => {
  it('a later status rewrite for the same head (retry, recovery) keeps the seal and the legacy flag', () => {
    store([seatRow()]);
    writeStatusFile(legacyStatus());
    publish([clearComment]); // seals and holds
    expect(readStatusFile().sealedBreaks).toHaveLength(1);
    const loopPayload = { findings: { read: { netBasis: { rev: head } } } };
    recordRedTeamStatus({ repo, pr: 42, loopPayload, status: 'finished', result: 'ran' }, { env: process.env });
    expect(readStatusFile()).toMatchObject({ legacyHoldPublished: true, result: 'ran' });
    expect(readStatusFile().sealedBreaks).toHaveLength(1);
    expect(heldBy([clearComment]).held.length).toBeGreaterThanOrEqual(1);
  });
  it('a carried "no break" comment on a new head keeps the hold of the head it was carried from', () => {
    store([seatRow()]);
    writeStatusFile(legacyStatus());
    publish([clearComment]);
    const next = 'b'.repeat(40);
    const carried = trusted([`<!-- review-verdict-carried from=${head} to=${next} patch-id=${'c'.repeat(40)} -->`,
      'Review verdict carried across an identical contribution.', redTeamMarker(42, next),
      '### Post-accept red team — no break found'].join('\n'));
    expect(readSealedStatus({ repo, pr: 42, head: next, env: process.env })).toBeNull(); // the new head has no status of its own
    const d = readRedTeamDisposition({ comments: [clearComment, carried], pr: 42, head: next, repo, env: process.env });
    expect(d.held.length).toBeGreaterThanOrEqual(1);
  });
  it('the planner reads the persisted seal, not the snapshot it was handed', () => {
    store([seatRow()]);
    writeStatusFile(legacyStatus());
    publish([clearComment]);
    const snapshotWithoutHold = { ...legacyStatus(), sealedBreaks: [] };
    expect(planRedTeamStatusLabels({ repo, pr: 42, head, env: process.env, labels: [], comments: [clearComment],
      evidence: { status: snapshotWithoutHold } }).add).toBe('red-team:blocked');
  });
});

describe('(e) every disposition caller reports the hold', () => {
  const seal = () => { store([seatRow()]); writeStatusFile(legacyStatus()); publish([clearComment]); };
  it('readRedTeamDisposition, the gate queue helpers and the drain enqueue hold all see held >= 1', () => {
    seal();
    const comments = [clearComment];
    expect(readRedTeamDisposition({ comments, pr: 42, head, repo }).held.length).toBeGreaterThanOrEqual(1);
    expect(redTeamRulingNeeded(prFor(comments))).toMatchObject({ head, findings: [expect.objectContaining({ index: 0 })] });
    expect(redTeamEnqueueHold({ comments, pr: 42, head, repo, ok: true, loopPayload: null })).toMatch(/confirmed a break/);
    expect(planRedTeamStatusLabels({ repo, pr: 42, head, env: process.env, labels: [], comments, evidence: {} }).add).toBe('red-team:blocked');
  });
  it.each([
    'scripts/lib/drain-queue-safety.mjs', 'scripts/lib/red-team-gate.mjs', 'scripts/lib/red-team-status-labels.mjs',
    'scripts/lib/red-team-carry-io.mjs', 'scripts/operations/needs-you-feed.mjs', 'scripts/operations/operator-queue.mjs',
    'scripts/operations/judge-sweep-facts-io.mjs', 'scripts/operations/record-red-team-ruling.mjs',
    'scripts/operations/record-red-team-ruling-io.mjs',
  ])('%s passes the repo to every readRedTeamDisposition call, so the shared reader finds the sealed status', file => {
    const text = readFileSync(join(import.meta.dirname, '..', '..', '..', file), 'utf8');
    const calls = [...text.matchAll(/readRedTeamDisposition\(\{([^}]*(?:\{[^}]*\}[^}]*)*)\}\)/g)].map(m => m[1]);
    expect(calls.length).toBeGreaterThan(0);
    // The operator-ruling replay inside red-team-gate.mjs reads with the disposition's own defaults by design.
    const withoutRepo = calls.filter(c => !/\brepo\b|\.\.\.key\(/.test(c));
    expect(withoutRepo).toHaveLength(file.endsWith('red-team-gate.mjs') ? 1 : 0);
  });
});
