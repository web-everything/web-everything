// @vitest-environment node
// The stored red-team evidence for a head is the single authority for "is it held" (PR #6622, operator send-back).
// Everything below runs the REAL functions end to end: the real default seat-row reader (scorecard store), the real
// status file, the real sweep and the real hold decision behind readRedTeamDisposition. Nothing injects a seat row.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publishStoredRedTeamResult } from '../red-team-withheld-publish.mjs';
import { planRedTeamStatusLabels, syncRedTeamStatusLabels } from '../red-team-status-labels.mjs';
import { readRedTeamDisposition, redTeamCarrySources, redTeamHoldDecision, redTeamRulingNeeded, redTeamMarker } from '../red-team-gate.mjs';
import { readSealedStatus, sealedStatusPath } from '../red-team-sealed-status.mjs';
import { redTeamEnqueueHold } from '../drain-queue-safety.mjs';
import { recordRedTeamStatus } from '../drain-red-team-evidence.mjs';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
import { writeStore, resolveScorecardStorePath } from '../../conveyor/run-scorecard-store.mjs';
import { sweepAdvisoryLabels } from '../../conveyor/advisory-label-sweep.mjs';
import { SHARED_RUNS_DIR_ENV } from '../../operations/run-store.mjs';
import { gateReadyItems, itemsFromReport } from '../../operations/needs-you-feed.mjs';

// Matches a `readRedTeamDisposition({ ... })` call with at most one level of nested braces. The character classes
// exclude BOTH braces, so each character has exactly one way to match (a `[^}]*` that may also eat `{` lets the
// nested group's repetitions overlap — exponential backtracking on a long run of `{`, CodeQL js/redos).
const READ_DISPOSITION_CALL = /readRedTeamDisposition\(\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}\)/g;
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
/** A trusted carry of the "no break found" result from `head` onto `to` (the carry machine's own comment shape). */
const carriedClear = to => trusted([`<!-- review-verdict-carried from=${head} to=${to} patch-id=${'c'.repeat(40)} -->`,
  'Review verdict carried across an identical contribution.', redTeamMarker(42, to),
  '### Post-accept red team — no break found'].join('\n'));
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
    // The seat row is the authority: unreadable, the posted "no break" comment cannot clear the head (held, alerted).
    const first = publish([clearComment]);
    expect(first.out).toEqual({ status: 'held' });
    expect(first.publishNeedsYou).toHaveBeenCalledTimes(1);
    expect(heldBy([clearComment]).held.length).toBeGreaterThanOrEqual(1);
    expect(planRedTeamStatusLabels({ repo, pr: 42, head, labels: ['red-team:clear'], comments: [clearComment], evidence: {} }))
      .toMatchObject({ add: 'red-team:blocked', remove: ['red-team:clear'] });
    expect(publish([]).out).toEqual({ status: 'held' });
  });
});

describe('the sealed status reader fails closed', () => {
  it('reads the very file the drain evidence writer writes (path parity, with and without the runs-dir override)', () => {
    const loopPayload = { findings: { read: { netBasis: { rev: head } } } };
    recordRedTeamStatus({ repo, pr: 42, loopPayload, status: 'finished', result: 'ran' }, { env: process.env });
    expect(JSON.parse(readFileSync(sealedStatusPath({ repo, pr: 42, head }, process.env), 'utf8'))).toMatchObject({ repo, pr: 42, head, result: 'ran' });
    // Without the override (review round 7, PR #6622): the WRITER writes under an isolated coordination root through its
    // own default path, and the reader finds that exact file at the documented default location.
    const coordination = join(dir, 'workspace', '.operations', 'coordination');
    const env = { ...process.env, WE_COORDINATION_ROOT: coordination };
    delete env[SHARED_RUNS_DIR_ENV];
    recordRedTeamStatus({ repo, pr: 42, loopPayload, status: 'finished', result: 'ran' }, { env });
    const defaultFile = join(dir, 'workspace', '.operations', 'red-team-status', `${encodeURIComponent(repo)}-42-${head}.json`);
    expect(JSON.parse(readFileSync(defaultFile, 'utf8'))).toMatchObject({ repo, pr: 42, head, status: 'finished', result: 'ran' });
    expect(sealedStatusPath({ repo, pr: 42, head }, env)).toBe(defaultFile);
    expect(readSealedStatus({ repo, pr: 42, head, env })).toMatchObject({ unsealed: true });
    // The override-set file is a different file, so the default read is not riding on it.
    expect(sealedStatusPath({ repo, pr: 42, head }, process.env)).not.toBe(defaultFile);
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
  // Before the publisher's first pass the status owes publication and carries no seal: nothing has compared the stored
  // evidence with the thread yet, so a trusted "no break found" comment must not clear any reader (live probe, #6622 head).
  it.each([
    ['a bare legacy `ran` result', legacyStatus()],
    ['a withheld result', { ...legacyStatus(), result: { status: 'ran', comment: 'withheld', findings: [brokenFinding] } }],
    ['an errored publication', { ...legacyStatus(), result: { status: 'ran', comment: 'error', findings: [brokenFinding] } }],
  ])('%s that owes publication and has no seal holds every reader before the publisher runs', (_name, status) => {
    store([seatRow()]);
    writeStatusFile(status);
    expect(readSealedStatus({ repo, pr: 42, head, env: process.env })).toMatchObject({ unsealed: true });
    expect(heldBy([clearComment]).held.length).toBeGreaterThanOrEqual(1);
    // Held, but named as what it is (publication pending), and unknown run evidence keeps its own reason.
    expect(redTeamEnqueueHold({ comments: [clearComment], pr: 42, head, repo, ok: true, loopPayload: null })).toMatch(/not published yet/);
    expect(redTeamEnqueueHold({ comments: [clearComment], pr: 42, head, repo, ok: false, reason: 'scan-capped', loopPayload: null }))
      .toMatch(/scan-capped/);
    // Not a break yet (nothing compared), so pending: never clear, and an existing clear label is stripped.
    expect(planRedTeamStatusLabels({ repo, pr: 42, head, env: process.env, labels: ['red-team:clear'], comments: [clearComment], evidence: {} }))
      .toEqual({ add: 'red-team:pending', remove: ['red-team:clear'] });
  });
  it('a carried result whose source head is unsealed: one sweep pass seals the source (posting nothing) and plans blocked', () => {
    // Head A holds the stored break, unsealed; the live head B carries A's "no break found" comment.
    const live = 'b'.repeat(40);
    store([seatRow()]);
    writeStatusFile(legacyStatus());
    const thread = [clearComment, { ...carriedClear(live), createdAt: '2026-11-10T12:05:00Z' }];
    const at = h => readRedTeamDisposition({ comments: thread, pr: 42, head: h, repo, env: process.env });
    // Precondition: the carry is read as a carry from A, and A's unsealed status holds B (pending, not clear).
    expect(at(live).held).toEqual([expect.objectContaining({ index: 0, unsealed: true })]);
    let labels = ['red-team:clear'];
    const posted = [];
    const view = () => ({ number: 42, state: 'OPEN', labels: labels.map(name => ({ name })), headRefOid: live, comments: thread, reviews: [] });
    sweepAdvisoryLabels({ repo, listPrs: () => [view()], readPr: view, log: () => {},
      provider: { currentRepo: () => repo, readComments: () => thread, postComment: (...a) => posted.push(a), ensureLabel: () => {},
        setLabels: (_r, _p, { add, remove }) => { labels = labels.filter(l => !remove.includes(l)); if (add && !labels.includes(add)) labels.push(add); } },
      listUnpublishedStatuses: () => [], publishStored: input => publishStoredRedTeamResult({ ...input, publishNeedsYou: () => {} }) });
    expect(posted).toEqual([]);
    expect(readStatusFile().sealedBreaks).toHaveLength(1);
    expect(at(live).held).toEqual([expect.objectContaining({ index: 0 })]);
    expect(at(live).held[0].unsealed).toBeUndefined();
    expect(labels).toEqual(['red-team:blocked']);
  });
  it('the sweep seals a carried-from head even when the run-evidence summary returns no status for it', () => {
    const live = 'b'.repeat(40);
    store([seatRow()]);
    writeStatusFile(legacyStatus());
    const thread = [clearComment, { ...carriedClear(live), createdAt: '2026-11-10T12:05:00Z' }];
    let labels = [];
    const view = () => ({ number: 42, state: 'OPEN', labels: labels.map(name => ({ name })), headRefOid: live, comments: thread, reviews: [] });
    sweepAdvisoryLabels({ repo, listPrs: () => [{ ...view(), labels: [{ name: 'red-team:pending' }] }], readPr: view, log: () => {},
      // The lossy summary: unknown run evidence, no status (a newer run, a parse cap, a read error).
      readStatusEvidence: () => ({ ok: false }),
      provider: { currentRepo: () => repo, readComments: () => thread, postComment: () => { throw Error('never'); }, ensureLabel: () => {},
        setLabels: (_r, _p, { add, remove }) => { labels = labels.filter(l => !remove.includes(l)); if (add && !labels.includes(add)) labels.push(add); } },
      listUnpublishedStatuses: () => [], publishStored: input => publishStoredRedTeamResult({ ...input, publishNeedsYou: () => {} }) });
    expect(readStatusFile().sealedBreaks).toHaveLength(1);
    expect(labels).toEqual(['red-team:blocked']);
  });
  it('a carried result from a source with no break: the source seals empty and the carried head is not held', () => {
    const live = 'b'.repeat(40);
    store([seatRow({ foldedVerdict: 'accept', confirmedMissCount: 0, findings: [] })]);
    writeStatusFile(legacyStatus());
    const thread = [clearComment, { ...carriedClear(live), createdAt: '2026-11-10T12:05:00Z' }];
    expect(publishStoredRedTeamResult({ status: readStatusFile(), sealOnly: true, listComments: () => thread,
      postComment: () => { throw Error('never'); }, publishNeedsYou: () => { throw Error('never'); } })).toEqual({ status: 'skipped' });
    expect(readStatusFile().sealedBreaks).toEqual([]);
    expect(readRedTeamDisposition({ comments: thread, pr: 42, head: live, repo, env: process.env }).held).toEqual([]);
  });
  it('a sealed carry source held by a stale conflict clears once its comments are corrected (the sweep revisits it)', () => {
    // A: finished legacy `ran`, clean exact-head row, but a stale trusted comment showing a break, carried to B.
    const live = 'b'.repeat(40);
    store([seatRow({ foldedVerdict: 'accept', confirmedMissCount: 0, findings: [] })]);
    writeStatusFile(legacyStatus());
    const carried = (body, to) => trusted([`<!-- review-verdict-carried from=${head} to=${to} patch-id=${'c'.repeat(40)} -->`,
      'Review verdict carried across an identical contribution.', body].join('\n'));
    const staleBreak = render([brokenFinding]);
    const staleCarry = { ...carried(render([brokenFinding], live).body, live), createdAt: '2026-11-10T12:05:00Z' };
    let thread = [staleBreak, staleCarry];
    let labels = [];
    const view = () => ({ number: 42, state: 'OPEN', labels: labels.map(name => ({ name })), headRefOid: live, comments: thread, reviews: [] });
    const sweep = () => sweepAdvisoryLabels({ repo, listPrs: () => [{ ...view(), labels: [{ name: 'red-team:pending' }] }], readPr: view,
      log: () => {}, listUnpublishedStatuses: () => [],
      provider: { currentRepo: () => repo, readComments: () => thread, postComment: () => { throw Error('never'); }, ensureLabel: () => {},
        setLabels: (_r, _p, { add, remove }) => { labels = labels.filter(l => !remove.includes(l)); if (add && !labels.includes(add)) labels.push(add); } },
      publishStored: input => publishStoredRedTeamResult({ ...input, publishNeedsYou: () => {} }) });
    sweep();
    // The conflict pass seals A empty and records the legacy hold: B is held.
    expect(readStatusFile()).toMatchObject({ sealedBreaks: [], legacyHoldPublished: true });
    expect(readRedTeamDisposition({ comments: thread, pr: 42, head: live, repo, env: process.env }).held.length).toBeGreaterThan(0);
    // Both trusted comments corrected to show no findings, the A-to-B carry kept.
    thread = [clearComment, { ...carriedClear(live), createdAt: '2026-11-10T12:10:00Z' }];
    sweep();
    expect(readStatusFile().legacyHoldPublished).toBeUndefined();
    expect(readRedTeamDisposition({ comments: thread, pr: 42, head: live, repo, env: process.env }).held).toEqual([]);
    expect(labels).not.toContain('red-team:blocked');
  });
  it('a flagged carry source with NO comment of its own (the stale one deleted) lifts its hold on a seal-only pass', () => {
    const live = 'b'.repeat(40);
    store([seatRow({ foldedVerdict: 'accept', confirmedMissCount: 0, findings: [] })]);
    writeStatusFile({ ...legacyStatus(), sealedBreaks: [], legacyHoldPublished: true });
    // Only B's carry stays in the thread: A's own stale comment was deleted, not edited.
    const thread = [{ ...carriedClear(live), createdAt: '2026-11-10T12:10:00Z' }];
    expect(readRedTeamDisposition({ comments: thread, pr: 42, head: live, repo, env: process.env }).held.length).toBeGreaterThan(0);
    expect(publishStoredRedTeamResult({ status: readStatusFile(), sealOnly: true, listComments: () => thread,
      postComment: () => { throw Error('never'); }, publishNeedsYou: () => { throw Error('never'); } })).toEqual({ status: 'sealed' });
    expect(readStatusFile().legacyHoldPublished).toBeUndefined();
    expect(readRedTeamDisposition({ comments: thread, pr: 42, head: live, repo, env: process.env }).held).toEqual([]);
  });
  it('a carry source flagged while its row was unreadable lifts once the row reads, but keeps a recovered break', () => {
    const live = 'b'.repeat(40);
    store([]);
    writeStatusFile(legacyStatus());
    const thread = [{ ...carriedClear(live), createdAt: '2026-11-10T12:10:00Z' }];
    const pass = () => publishStoredRedTeamResult({ status: readStatusFile(), sealOnly: true, listComments: () => thread,
      postComment: () => { throw Error('never'); }, publishNeedsYou: () => {} });
    expect(pass()).toEqual({ status: 'held' });
    expect(readStatusFile().legacyHoldPublished).toBe(true);
    store([seatRow()]);
    expect(pass()).toEqual({ status: 'sealed' });
    expect(readStatusFile()).toMatchObject({ sealedBreaks: [expect.any(String)] });
    expect(readStatusFile().legacyHoldPublished).toBeUndefined();
    // The flag is gone, yet the recovered confirmed break still holds the carried "no break found" head.
    expect(readRedTeamDisposition({ comments: thread, pr: 42, head: live, repo, env: process.env }).held.length).toBeGreaterThan(0);
  });
  it('a stored row with no confirmed break seals an EMPTY list, which lifts the unsealed hold for an agreeing comment', () => {
    store([seatRow({ foldedVerdict: 'accept', confirmedMissCount: 0, findings: [] })]);
    writeStatusFile(legacyStatus());
    expect(heldBy([clearComment]).held.length).toBeGreaterThanOrEqual(1);
    expect(publish([clearComment]).out).toEqual({ status: 'skipped' });
    expect(readStatusFile().sealedBreaks).toEqual([]);
    expect(heldBy([clearComment]).held).toEqual([]);
  });
  it('the needs-you feed never approves an unsealed head, and does not call it a confirmed break either', async () => {
    store([seatRow()]);
    writeStatusFile(legacyStatus());
    const gh = async (_f, args) => args[0] === 'api'
      ? JSON.stringify([[{ user: { login: 'web-everything' }, body: clearComment.body, created_at: clearComment.createdAt }]])
      : JSON.stringify({ headRefOid: head, labels: [] });
    const report = { ready: [{ repo, number: 42, title: 't' }] };
    const { kept, held } = await gateReadyItems(itemsFromReport(report), report, { gh, log: () => {}, fixClaimLive: () => false });
    expect(held).toEqual([]);
    expect(kept.filter(i => i.pr === 42 && ['needs-you', 'confirmed-break-owed-send-back', 'red-team-undecided'].includes(i.kind)))
      .toEqual([expect.objectContaining({ head, kind: 'red-team-undecided' })]);
  });
  it('a status already published (comment posted) with no confirmed break needs no seal: it holds nothing on its own', () => {
    writeStatusFile({ ...legacyStatus(), result: { status: 'ran', comment: 'posted', findings: [] } });
    // Its own findings are the stored evidence (self-review round 3): an empty list, so nothing is held.
    expect(readSealedStatus({ repo, pr: 42, head, env: process.env })).toEqual({ findings: [], legacyHold: false });
    expect(heldBy([clearComment]).held).toEqual([]);
  });
  it('the pure decision: no seal holds nothing, an empty seal holds nothing, an unreadable seal holds', () => {
    expect(redTeamHoldDecision({ comments: [], pr: 42, head, sealed: null }).held).toBe(false);
    expect(redTeamHoldDecision({ comments: [], pr: 42, head, sealed: { breaks: [] } }).held).toBe(false);
    expect(redTeamHoldDecision({ comments: [], pr: 42, head, sealed: { unreadable: true } }).held).toBe(true);
  });
});

describe('every publish path seals, and the publisher\'s own comment always agrees with its seal (self-review round 2)', () => {
  const withheld = findings => ({ repo, pr: 42, head, status: 'finished',
    result: { status: 'ran', comment: 'withheld', provider: 'claude', model: 'test-model', recheckStatus: 'ok',
      foldedVerdict: 'changes', confirmedMissCount: findings.filter(f => f.confirmedByRecheck).length, findings } });
  it('a non-legacy withheld result with a comment already posted is sealed: a "no break" comment holds', () => {
    writeStatusFile(withheld([brokenFinding]));
    expect(publish([clearComment]).out).toEqual({ status: 'skipped' });
    expect(readStatusFile().sealedBreaks).toHaveLength(1);
    expect(heldBy([clearComment]).held.length).toBeGreaterThanOrEqual(1);
    expect(planRedTeamStatusLabels({ repo, pr: 42, head, env: process.env, labels: ['red-team:clear'], comments: [clearComment], evidence: {} }).add)
      .toBe('red-team:blocked');
  });
  it('a non-legacy result whose findings are unreadable seals as unreadable and holds', () => {
    writeStatusFile({ ...withheld([]), result: { status: 'ran', comment: 'withheld', findings: 'garbled' } });
    publish([clearComment]);
    expect(readStatusFile().sealedBreaks).toBe('unreadable');
    expect(heldBy([clearComment]).held.length).toBeGreaterThanOrEqual(1);
  });
  it('a scrub-fallback (minimal) body the publisher posts agrees with its seal; a different body still holds', () => {
    // The full body fails the secret scrub (here: a scrub that flags the scenario only the full body shows), so the
    // publisher falls back to its minimal form.
    const secretFinding = { ...brokenFinding, failure_scenario: 'replay the token' };
    writeStatusFile(withheld([secretFinding]));
    const { out, postComment } = publish([], { scrub: body => (body.includes('replay the token') ? ['credential'] : []) });
    expect(out).toEqual({ status: 'posted' });
    const body = postComment.mock.calls[0][0].body;
    expect(body).toMatch(/summary withheld/);
    expect(readStatusFile().sealedPosted).toHaveLength(1);
    const posted = trusted(body);
    // Not held forever by its own comment: the stored break is shown (confirmed, impact unknown = broken) to the gate.
    expect(redTeamHoldDecision({ comments: [posted], pr: 42, head, sealed: readSealedStatus({ repo, pr: 42, head, env: process.env }) }).held).toBe(false);
    // A comment that is neither the full body nor the sealed fallback still holds.
    expect(redTeamHoldDecision({ comments: [clearComment], pr: 42, head, sealed: readSealedStatus({ repo, pr: 42, head, env: process.env }) }).held).toBe(true);
  });
  it('the seal reads only the fields the renderer shows: an `impact`/`scenario` alias cannot make the faithful comment disagree', () => {
    const aliased = { summary: 'Aliased fields', file: 'scripts/z.mjs', line: 3, category: 'correctness', impact: 'cosmetic',
      scenario: 'not rendered', confirmedByRecheck: true };
    writeStatusFile(withheld([aliased]));
    const { postComment } = publish([]);
    const posted = trusted(postComment.mock.calls[0][0].body);
    expect(redTeamHoldDecision({ comments: [posted], pr: 42, head, sealed: readSealedStatus({ repo, pr: 42, head, env: process.env }) }).held).toBe(false);
  });
  it('a planner called with a partial env ({}) still finds the seal the publisher wrote under the process env', () => {
    store([seatRow()]); writeStatusFile(legacyStatus()); publish([clearComment]);
    expect(planRedTeamStatusLabels({ repo, pr: 42, head, env: {}, labels: ['red-team:clear'], comments: [clearComment], evidence: {} }).add)
      .toBe('red-team:blocked');
  });
  it('a drain rewrite of a damaged status that carried a seal fails closed (unreadable), never "nothing sealed"', () => {
    store([seatRow()]); writeStatusFile(legacyStatus()); publish([clearComment]);
    writeFileSync(statusFile(), `${JSON.stringify(readStatusFile()).slice(0, -5)}`); // truncated JSON, still names the seal
    const loopPayload = { findings: { read: { netBasis: { rev: head } } } };
    recordRedTeamStatus({ repo, pr: 42, loopPayload, status: 'finished', result: 'ran' }, { env: process.env });
    expect(readStatusFile().sealedBreaks).toBe('unreadable');
    expect(heldBy([clearComment]).held.length).toBeGreaterThanOrEqual(1);
  });
  it('the drain writer waits on the publisher\'s status lock (one lock, no interleaved rewrite)', () => {
    store([seatRow()]); writeStatusFile(legacyStatus());
    writeFileSync(`${statusFile()}.lock`, `${process.pid}\n`); // the publisher holds it (this live pid)
    const loopPayload = { findings: { read: { netBasis: { rev: head } } } };
    const started = Date.now();
    // While the publisher holds it, the drain waits and then reports busy (retry next tick) without writing.
    expect(() => recordRedTeamStatus({ repo, pr: 42, loopPayload, status: 'finished', result: 'ran' },
      { env: process.env, lockTimeoutMs: 200 })).toThrow(/busy/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(readStatusFile()).toEqual(legacyStatus()); // untouched while the lock is held
    rmSync(`${statusFile()}.lock`, { force: true });
    recordRedTeamStatus({ repo, pr: 42, loopPayload, status: 'finished', result: 'ran' }, { env: process.env, lockTimeoutMs: 200 });
    expect(readStatusFile()).toMatchObject({ status: 'finished', result: 'ran' });
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
  // Red-team round 9 (PR #6622): the carry chase stopped after eight hops, so a ninth carry lost the original seal.
  it.each([8, 9, 20])('a chain of %i carries (no status on any intermediate head) still holds on the original seal', hops => {
    store([seatRow()]);
    writeStatusFile(legacyStatus());
    publish([clearComment]);
    const heads = [head, ...Array.from({ length: hops }, (_, i) => (i + 1).toString(16).padStart(40, 'b'))];
    const thread = [clearComment, ...heads.slice(1).map((to, i) => ({
      ...trusted([`<!-- review-verdict-carried from=${heads[i]} to=${to} patch-id=${'c'.repeat(40)} -->`,
        'Review verdict carried across an identical contribution.', redTeamMarker(42, to),
        '### Post-accept red team — no break found'].join('\n')),
      createdAt: new Date(Date.parse('2026-11-10T12:01:00Z') + i * 60000).toISOString() }))];
    const live = heads.at(-1);
    expect(redTeamCarrySources({ comments: thread, pr: 42, head: live })).toEqual(heads.slice(0, -1).reverse());
    const d = readRedTeamDisposition({ comments: thread, pr: 42, head: live, repo, env: process.env });
    expect(d.held.length).toBeGreaterThanOrEqual(1);
  });
  // Seals are per head: a stale clean seal on a revisited live head, or on an intermediate head, must not mask the carry
  // origin's sealed break (round 9 self-review). Every seal on the chain is checked.
  const writeCleanSeal = h => {
    const p = sealedStatusPath({ repo, pr: 42, head: h }, process.env);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, JSON.stringify({ repo, pr: 42, head: h, status: 'finished', result: 'ran', sealedBreaks: [] }));
  };
  const carry = (from, to, minute) => ({ ...trusted([`<!-- review-verdict-carried from=${from} to=${to} patch-id=${'c'.repeat(40)} -->`,
    'Review verdict carried across an identical contribution.', redTeamMarker(42, to),
    '### Post-accept red team — no break found'].join('\n')), createdAt: `2026-11-10T12:${String(minute).padStart(2, '0')}:00Z` });
  it('a force-push back to a head with its own older clean seal still holds on the carry origin\'s sealed break', () => {
    store([seatRow()]);
    writeStatusFile(legacyStatus());
    publish([clearComment]);
    const back = 'b'.repeat(40);
    writeCleanSeal(back);
    expect(readSealedStatus({ repo, pr: 42, head: back, env: process.env })).toEqual({ breaks: [], legacyHold: false });
    const d = readRedTeamDisposition({ comments: [clearComment, carry(head, back, 5)], pr: 42, head: back, repo, env: process.env });
    expect(d.held).toEqual([expect.objectContaining({ index: 0 })]);
  });
  it('an intermediate head\'s own clean seal does not mask the carry origin\'s sealed break', () => {
    store([seatRow()]);
    writeStatusFile(legacyStatus());
    publish([clearComment]);
    const mid = 'b'.repeat(40), live = 'd'.repeat(40);
    writeCleanSeal(mid);
    const thread = [clearComment, carry(head, mid, 5), carry(mid, live, 6)];
    expect(readRedTeamDisposition({ comments: thread, pr: 42, head: live, repo, env: process.env }).held)
      .toEqual([expect.objectContaining({ index: 0 })]);
  });
  it('clean seals on every head of the chain hold nothing (no false hold)', () => {
    writeCleanSeal(head);
    const mid = 'b'.repeat(40), live = 'd'.repeat(40);
    writeCleanSeal(mid);
    writeCleanSeal(live);
    const thread = [clearComment, carry(head, mid, 5), carry(mid, live, 6)];
    expect(readRedTeamDisposition({ comments: thread, pr: 42, head: live, repo, env: process.env }).held).toEqual([]);
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

describe('the stored result is the authority on every status shape (self-review round 3)', () => {
  const loopPayload = { findings: { read: { netBasis: { rev: head } } } };
  const later = c => ({ ...c, createdAt: '2026-11-10T13:00:00Z' });
  // The REAL stored shape of a seat-posted result: review-job keeps only these five fields per finding (live data: 370
  // stored findings, all of this shape). The thread's comment is rendered from the FULL finding.
  const stored = f => ({ summary: f.summary, file: f.file ?? null, line: f.line ?? null, category: f.category ?? null,
    confirmed: f.confirmedByRecheck === true });
  const posted = findings => ({ status: 'ran', comment: 'posted', foldedVerdict: 'changes', recheckStatus: 'ok',
    provider: 'claude', model: 'test-model', findings: findings.map(stored) });
  it('a result the seat posted itself (never sealed) is not lifted by a later trusted "no break found" comment', () => {
    writeStatusFile({ repo, pr: 42, head, status: 'finished', result: posted([brokenFinding]) });
    const comments = [render([brokenFinding]), later(clearComment)];
    expect(heldBy(comments).held.length).toBeGreaterThanOrEqual(1);
    expect(planRedTeamStatusLabels({ repo, pr: 42, head, env: process.env, labels: ['red-team:pending'], comments, evidence: {} }).add)
      .toBe('red-team:blocked');
    expect(redTeamEnqueueHold({ comments, pr: 42, head, repo, ok: true, loopPayload: null })).toMatch(/confirmed a break/);
  });
  it('the same posted result with its own faithful comment adds no extra hold (the comment agrees)', () => {
    writeStatusFile({ repo, pr: 42, head, status: 'finished', result: posted([brokenFinding]) });
    expect(heldBy([render([brokenFinding])]).held.filter(f => f.index === 0)).toEqual([]);
    // The full renderer adds a scenario, a class and its basis the stored projection never carries: still the same breaks.
    const rich = { ...brokenFinding, failure_scenario: 'Given X, the check is skipped.', findingClass: 'live-reproduced',
      classBasis: 'Reproduced against the real reader.' };
    writeStatusFile({ repo, pr: 42, head, status: 'finished', result: posted([rich, { ...otherFinding, confirmedByRecheck: false }]) });
    expect(heldBy([render([rich, { ...otherFinding, confirmedByRecheck: false }])]).held.filter(f => f.index === 0)).toEqual([]);
  });
  it('the same posted result with a DIFFERENT break in the thread is held (whole bodies, never counts)', () => {
    writeStatusFile({ repo, pr: 42, head, status: 'finished', result: posted([brokenFinding]) });
    expect(heldBy([render([otherFinding])]).held.some(f => f.index === 0)).toBe(true);
  });
  it('a posted result whose findings cannot be read holds (fail closed)', () => {
    writeStatusFile({ repo, pr: 42, head, status: 'finished', result: { status: 'ran', comment: 'posted' } });
    expect(readSealedStatus({ repo, pr: 42, head, env: process.env })).toEqual({ unreadable: true });
    expect(heldBy([clearComment]).held.length).toBeGreaterThanOrEqual(1);
  });
  it('a NEW result drops the old seal: an empty seal never vouches for a retry that found a break', () => {
    writeStatusFile({ repo, pr: 42, head, status: 'finished', result: posted([]), sealedBreaks: [] });
    expect(heldBy([clearComment]).held).toEqual([]);
    recordRedTeamStatus({ repo, pr: 42, loopPayload, status: 'finished',
      result: { ...posted([brokenFinding]), comment: 'withheld' } }, { env: process.env });
    expect(readStatusFile().sealedBreaks).toBeUndefined();
    expect(heldBy([clearComment]).held.length).toBeGreaterThanOrEqual(1);
  });
  it('a rewrite with no result yet, or the same result, keeps the seal', () => {
    writeStatusFile({ repo, pr: 42, head, status: 'finished', result: posted([brokenFinding]), sealedBreaks: ['k'] });
    recordRedTeamStatus({ repo, pr: 42, loopPayload, status: 'running' }, { env: process.env });
    expect(readStatusFile().sealedBreaks).toEqual(['k']);
    writeStatusFile({ repo, pr: 42, head, status: 'finished', result: posted([brokenFinding]), sealedBreaks: ['k'] });
    // Only the publication state moved (the publisher's own `comment`): still the same result.
    recordRedTeamStatus({ repo, pr: 42, loopPayload, status: 'finished', result: { ...posted([brokenFinding]), comment: 'withheld' } },
      { env: process.env });
    expect(readStatusFile().sealedBreaks).toEqual(['k']);
  });
  it('a resume (bare `resumed` result) keeps the pass\'s seal: a later "no break found" comment still holds', () => {
    store([seatRow()]);
    writeStatusFile(legacyStatus());
    publish([clearComment]); // seals the stored break
    recordRedTeamStatus({ repo, pr: 42, loopPayload, status: 'finished', result: 'resumed' }, { env: process.env });
    expect(readStatusFile().sealedBreaks).toHaveLength(1);
    expect(heldBy([clearComment]).held.length).toBeGreaterThanOrEqual(1);
  });
  it('a resume of an unsealed seat-posted (deduped) result carries its stored findings, through a later running rewrite too', () => {
    writeStatusFile({ repo, pr: 42, head, status: 'finished', result: { ...posted([brokenFinding]), comment: 'deduped' } });
    recordRedTeamStatus({ repo, pr: 42, loopPayload, status: 'finished', result: 'resumed' }, { env: process.env });
    expect(readStatusFile()).toMatchObject({ result: 'resumed', storedFindings: [expect.objectContaining({ confirmed: true })] });
    expect(heldBy([render([brokenFinding]), later(clearComment)]).held.length).toBeGreaterThanOrEqual(1);
    expect(heldBy([render([brokenFinding])]).held.filter(f => f.index === 0)).toEqual([]);
    recordRedTeamStatus({ repo, pr: 42, loopPayload, status: 'running' }, { env: process.env });
    expect(readStatusFile().storedFindings).toHaveLength(1);
    // A NEW result drops the carried findings (the new result is the evidence now).
    recordRedTeamStatus({ repo, pr: 42, loopPayload, status: 'finished', result: posted([]) }, { env: process.env });
    expect(readStatusFile().storedFindings).toBeUndefined();
  });
  // Review round 7 (PR #6622): a retry rewrites a finished, unsealed seat-posted result as queued/running with no
  // result. That rewrite removed the result, and with it the only stored findings, so a clear comment lifted the hold.
  it.each([['posted'], ['deduped']])('running rewrite preserves unsealed seat-posted findings (%s)', comment => {
    writeStatusFile({ repo, pr: 42, head, status: 'finished', result: { ...posted([brokenFinding]), comment } });
    for (const status of ['queued', 'running']) {
      recordRedTeamStatus({ repo, pr: 42, loopPayload, status }, { env: process.env });
      expect(readStatusFile()).toMatchObject({ status, result: null, storedFindings: [expect.objectContaining({ confirmed: true })] });
      expect(readSealedStatus({ repo, pr: 42, head, env: process.env })).toMatchObject({ findings: [expect.objectContaining({ confirmed: true })] });
      expect(heldBy([render([brokenFinding]), later(clearComment)]).held.length).toBeGreaterThanOrEqual(1);
      expect(heldBy([clearComment]).held.length).toBeGreaterThanOrEqual(1);
    }
    // The replacement result is the evidence now: it drops the carried findings.
    recordRedTeamStatus({ repo, pr: 42, loopPayload, status: 'finished', result: posted([]) }, { env: process.env });
    expect(readStatusFile().storedFindings).toBeUndefined();
  });
  // The rest of the no-result rewrite matrix: every stored shape that held before the rewrite still holds after it.
  it.each([
    ['unreadable seat-posted findings', { status: 'finished', result: { status: 'ran', comment: 'posted' } }, 'unreadable'],
    ['a withheld result that owes publication', { status: 'finished', result: { ...posted([brokenFinding]), comment: 'withheld' } }, 'findings'],
    ['an unsealed bare legacy `ran` result', { status: 'finished', result: 'ran' }, 'unreadable'],
  ])('a running rewrite of %s keeps it held', (_name, prior, kind) => {
    writeStatusFile({ repo, pr: 42, head, ...prior });
    expect(heldBy([clearComment]).held.length).toBeGreaterThanOrEqual(1);
    recordRedTeamStatus({ repo, pr: 42, loopPayload, status: 'running' }, { env: process.env });
    const sealed = readSealedStatus({ repo, pr: 42, head, env: process.env });
    expect(kind === 'unreadable' ? sealed : sealed?.findings).toEqual(kind === 'unreadable' ? { unreadable: true } : [expect.objectContaining({ confirmed: true })]);
    expect(heldBy([clearComment]).held.length).toBeGreaterThanOrEqual(1);
  });
  // The REAL queued writers (review-job's fresh admission, the retry admission) re-send the prior result with status
  // `queued`; the reader takes a result as evidence only when finished, so the findings must be carried there too.
  it.each([
    ['a deduped seat-posted result', () => ({ ...posted([brokenFinding]), comment: 'deduped' }), 'findings'],
    ['a withheld result', () => ({ ...posted([brokenFinding]), comment: 'withheld' }), 'findings'],
  ])('a queued retry that re-sends %s keeps it held, through running and a finished error or skip', (_name, priorResult, kind) => {
    writeStatusFile({ repo, pr: 42, head, status: 'finished', result: priorResult() });
    const expectHeld = () => {
      const sealed = readSealedStatus({ repo, pr: 42, head, env: process.env });
      expect(kind === 'unreadable' ? sealed : sealed?.findings).toEqual(kind === 'unreadable' ? { unreadable: true } : [expect.objectContaining({ confirmed: true })]);
      expect(heldBy([clearComment]).held.length).toBeGreaterThanOrEqual(1);
    };
    recordRedTeamStatus({ repo, pr: 42, loopPayload, status: 'queued', result: priorResult() }, { env: process.env });
    expectHeld();
    recordRedTeamStatus({ repo, pr: 42, loopPayload, status: 'running' }, { env: process.env });
    expectHeld();
    // An error or a skip is not a replacement result: it carries no findings of its own.
    for (const result of [{ status: 'error' }, 'skipped']) {
      recordRedTeamStatus({ repo, pr: 42, loopPayload, status: 'finished', result }, { env: process.env });
      if (kind === 'findings') expectHeld();
      recordRedTeamStatus({ repo, pr: 42, loopPayload, status: 'running' }, { env: process.env });
      expectHeld();
    }
    recordRedTeamStatus({ repo, pr: 42, loopPayload, status: 'finished', result: posted([]) }, { env: process.env });
    expect(readStatusFile().storedFindings).toBeUndefined();
    expect(heldBy([clearComment]).held).toEqual([]);
  });
  // The legacy shape's findings live only in the seat row: held while its retry is pending, but a retry that FINISHES
  // without a `ran` result (error, skip) drops the carry, or nothing would ever clear the hold (self-review, PR #6622).
  it.each([[{ status: 'error' }], ['skipped'], ['resumed']])('an unsealed bare legacy `ran` is held while its retry is pending, and a finished %j retry drops the carry', result => {
    writeStatusFile({ repo, pr: 42, head, status: 'finished', result: 'ran' });
    for (const status of ['queued', 'running']) {
      recordRedTeamStatus({ repo, pr: 42, loopPayload, status, ...(status === 'queued' ? { result: 'ran' } : {}) }, { env: process.env });
      expect(readSealedStatus({ repo, pr: 42, head, env: process.env })).toEqual({ unreadable: true });
      expect(heldBy([clearComment]).held.length).toBeGreaterThanOrEqual(1);
    }
    recordRedTeamStatus({ repo, pr: 42, loopPayload, status: 'finished', result }, { env: process.env });
    expect(readStatusFile().storedFindings).toBeUndefined();
    recordRedTeamStatus({ repo, pr: 42, loopPayload, status: 'running' }, { env: process.env });
    expect(readStatusFile().storedFindings).toBeUndefined();
  });
  // Review round 8 (PR #6622): a SEALED result's confirmed breaks must survive queued/running/error/skip rewrites until a
  // replacement finished `ran` result supplies evidence. A failed retry dropped the seal of a sealed legacy `ran`.
  it.each([[{ status: 'error' }], ['skipped'], ['resumed']])('failed retry preserves sealed legacy confirmed breaks (finished %j)', result => {
    store([seatRow()]);
    writeStatusFile(legacyStatus());
    publish([clearComment]); // seals the seat row's confirmed break against the conflicting clear comment
    expect(readStatusFile().sealedBreaks).toHaveLength(1);
    const expectHeld = () => {
      expect(readSealedStatus({ repo, pr: 42, head, env: process.env })).toMatchObject({ breaks: [expect.any(String)] });
      expect(heldBy([clearComment]).held.length).toBeGreaterThanOrEqual(1);
    };
    recordRedTeamStatus({ repo, pr: 42, loopPayload, status: 'queued', result: 'ran' }, { env: process.env });
    expectHeld();
    recordRedTeamStatus({ repo, pr: 42, loopPayload, status: 'running' }, { env: process.env });
    expectHeld();
    recordRedTeamStatus({ repo, pr: 42, loopPayload, status: 'finished', result }, { env: process.env });
    expectHeld();
    recordRedTeamStatus({ repo, pr: 42, loopPayload, status: 'running' }, { env: process.env });
    expectHeld();
    // Only a replacement finished `ran` result drops the seal (the publisher seals that result itself).
    recordRedTeamStatus({ repo, pr: 42, loopPayload, status: 'finished', result: posted([]) }, { env: process.env });
    expect(readStatusFile().sealedBreaks).toBeUndefined();
    expect(heldBy([clearComment]).held).toEqual([]);
  });
  // Self-review (round 8): recovery queues a NEW pass's bare `ran` after a running rewrite; the old pass's seal must not
  // vouch for it, at queued or once it finishes (as `ran` again via already-ran, or as `resumed`).
  it.each([['ran'], ['resumed']])('a recovery that queues a new pass\'s `ran` drops the old seal (finished %s)', finished => {
    writeStatusFile({ ...legacyStatus(), sealedBreaks: [], legacyHoldPublished: true });
    recordRedTeamStatus({ repo, pr: 42, loopPayload, status: 'running' }, { env: process.env });
    expect(readStatusFile().sealedBreaks).toEqual([]);
    recordRedTeamStatus({ repo, pr: 42, loopPayload, status: 'queued', result: 'ran' }, { env: process.env });
    expect(readStatusFile().sealedBreaks).toBeUndefined();
    expect(readStatusFile().legacyHoldPublished).toBeUndefined();
    recordRedTeamStatus({ repo, pr: 42, loopPayload, status: 'finished', result: finished }, { env: process.env });
    expect(readStatusFile().sealedBreaks).toBeUndefined();
    if (finished === 'ran') expect(readSealedStatus({ repo, pr: 42, head, env: process.env })).toMatchObject({ unsealed: true });
  });
  // Self-review (round 8): a flagged, UNSEALED legacy `ran` (flag raised over an unreadable failed seat row, no comment)
  // is exactly what the retry admits. A retry that fails must not leave a hold nothing can clear: the publisher lifts the
  // flag only on a finished bare `ran`, so the flag counts only there.
  it.each([['failed'], [{ status: 'error' }]])('a flagged unsealed legacy `ran` whose retry finishes %j is not held forever', finished => {
    writeStatusFile({ ...legacyStatus(), legacyHoldPublished: true });
    expect(readSealedStatus({ repo, pr: 42, head, env: process.env })).toMatchObject({ unsealed: true, legacyHold: true });
    recordRedTeamStatus({ repo, pr: 42, loopPayload, status: 'queued', result: 'ran' }, { env: process.env });
    recordRedTeamStatus({ repo, pr: 42, loopPayload, status: 'running' }, { env: process.env });
    recordRedTeamStatus({ repo, pr: 42, loopPayload, status: 'finished', result: finished }, { env: process.env });
    expect(readSealedStatus({ repo, pr: 42, head, env: process.env })).toBeNull();
  });
  it('failed retry preserves a sealed seat-posted result\'s seal too (the seal, not only the carried findings)', () => {
    writeStatusFile({ repo, pr: 42, head, status: 'finished', result: { ...posted([brokenFinding]), comment: 'withheld' }, sealedBreaks: ['k'] });
    recordRedTeamStatus({ repo, pr: 42, loopPayload, status: 'running' }, { env: process.env });
    recordRedTeamStatus({ repo, pr: 42, loopPayload, status: 'finished', result: { status: 'error' } }, { env: process.env });
    expect(readStatusFile().sealedBreaks).toEqual(['k']);
  });
  it('a truncated status file with no stored evidence is repaired as nothing stored (no permanent unreadable seal)', () => {
    const whole = JSON.stringify({ repo, pr: 42, head, loopPayload, status: 'running', result: null });
    mkdirSync(join(statusFile(), '..'), { recursive: true });
    writeFileSync(statusFile(), whole.slice(0, -5));
    recordRedTeamStatus({ repo, pr: 42, loopPayload, status: 'finished', result: posted([]) }, { env: process.env });
    expect(readStatusFile().sealedBreaks).toBeUndefined();
    expect(heldBy([clearComment]).held).toEqual([]);
  });
  it('a truncated status file whose evidence is a seat-posted result is repaired as unreadable, never as nothing stored', () => {
    const whole = JSON.stringify({ repo, pr: 42, head, status: 'finished', result: posted([brokenFinding]) });
    mkdirSync(join(statusFile(), '..'), { recursive: true });
    writeFileSync(statusFile(), whole.slice(0, whole.indexOf('"findings"') + 14));
    expect(readSealedStatus({ repo, pr: 42, head, env: process.env })).toEqual({ unreadable: true });
    recordRedTeamStatus({ repo, pr: 42, loopPayload, status: 'running' }, { env: process.env });
    expect(readSealedStatus({ repo, pr: 42, head, env: process.env })).toEqual({ unreadable: true });
    expect(heldBy([clearComment]).held.length).toBeGreaterThanOrEqual(1);
  });
  it('a no-result rewrite after a clean seat-posted result holds nothing (no false hold)', () => {
    writeStatusFile({ repo, pr: 42, head, status: 'finished', result: posted([]) });
    recordRedTeamStatus({ repo, pr: 42, loopPayload, status: 'running' }, { env: process.env });
    expect(readStatusFile().storedFindings).toEqual([]);
    expect(heldBy([clearComment]).held).toEqual([]);
  });
  it('a "publication pending" hold asks no ruling (no false round-cap row), yet still holds the merge', () => {
    store([seatRow()]);
    writeStatusFile(legacyStatus());
    expect(heldBy([clearComment]).held.length).toBeGreaterThanOrEqual(1);
    expect(redTeamRulingNeeded(prFor([clearComment]))).toBeNull();
    expect(redTeamEnqueueHold({ comments: [clearComment], pr: 42, head, repo, ok: true, loopPayload: null })).toMatch(/not published yet/);
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
  it('the needs-you feed (gateReadyItems) never offers the sealed head for approval: it reports the owed break', async () => {
    seal();
    // The live PR read the feed makes, in gh's own shapes: the view, then the paged comment thread.
    const gh = async (_f, args) => args[0] === 'api'
      ? JSON.stringify([[{ user: { login: 'web-everything' }, body: clearComment.body, created_at: clearComment.createdAt }]])
      : JSON.stringify({ headRefOid: head, labels: [] });
    const report = { ready: [{ repo, number: 42, title: 't' }] };
    const { kept, held } = await gateReadyItems(itemsFromReport(report), report, { gh, log: () => {}, fixClaimLive: () => false });
    expect(held).toEqual([]);
    // The report's other derived rows pass through untouched; the approval row itself becomes the owed break.
    expect(kept.filter(i => i.pr === 42 && ['needs-you', 'confirmed-break-owed-send-back'].includes(i.kind)))
      .toEqual([expect.objectContaining({ head, kind: 'confirmed-break-owed-send-back' })]);
  });
  it.each([
    'scripts/lib/drain-queue-safety.mjs', 'scripts/lib/red-team-gate.mjs', 'scripts/lib/red-team-status-labels.mjs',
    'scripts/lib/red-team-carry-io.mjs', 'scripts/operations/needs-you-feed.mjs', 'scripts/operations/operator-queue.mjs',
    'scripts/operations/judge-sweep-facts-io.mjs', 'scripts/operations/record-red-team-ruling.mjs',
    'scripts/operations/record-red-team-ruling-io.mjs',
  ])('%s passes the repo to every readRedTeamDisposition call, so the shared reader finds the sealed status', file => {
    const text = readFileSync(join(import.meta.dirname, '..', '..', '..', file), 'utf8');
    const calls = [...text.matchAll(READ_DISPOSITION_CALL)].map(m => m[1]);
    expect(calls.length).toBeGreaterThan(0);
    // The operator-ruling replay inside red-team-gate.mjs reads with the disposition's own defaults by design.
    const withoutRepo = calls.filter(c => !/\brepo\b|\.\.\.key\(/.test(c));
    expect(withoutRepo).toHaveLength(file.endsWith('red-team-gate.mjs') ? 1 : 0);
  });
  it('the call-finder regex finishes at once on a long run of unbalanced braces (no exponential backtracking)', () => {
    const hostile = `readRedTeamDisposition({${'{{}'.repeat(40)}`;
    // vm's timeout aborts a runaway synchronous regex — the old `[^}]*(?:\{[^}]*\}[^}]*)*` shape never returns here.
    const run = () => vm.runInNewContext('hostile.match(re)', { hostile, re: new RegExp(READ_DISPOSITION_CALL.source, 'g') }, { timeout: 1000 });
    expect(run).not.toThrow();
    expect(run()).toBeNull();
    // And it still finds a real call, including one nested object.
    const real = 'x = readRedTeamDisposition({ repo, key: { a: 1 }, pr });';
    expect([...real.matchAll(READ_DISPOSITION_CALL)].map(m => m[1])).toEqual([' repo, key: { a: 1 }, pr ']);
  });
});
