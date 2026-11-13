import { describe, it, expect, vi, afterEach } from 'vitest';

// Keep even the default rerun transport hermetic; no test may invoke gh.
vi.mock('../../lib/gh-throttle.mjs', async importOriginal => ({
  ...await importOriginal(),
  runGhSync: vi.fn(() => ''),
  execFileSyncThrottled: vi.fn(() => { throw new Error('unexpected subprocess'); }),
}));

import { runGhSync } from '../../lib/gh-throttle.mjs';
import {
  planMergeGateInputRerun,
  sweepMergeGateInputRerun,
  formatMergeGateInputRerunReport,
} from '../merge-gate-input-rerun.mjs';
import { main } from '../ci-red-recovery-watch.mjs';
import { buildStandDownComment, buildLoadFlakeHoldComment } from '../stand-down.mjs';

const REPO = 'web-everything/web-everything';
const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const JOB = 987654;
const AT = '2026-11-13T19:00:00Z';
const LATER = '2026-11-13T19:01:00Z';
const MARKER = '<!-- we:merge-gate-input-rerun -->';
const missing = () => ({ id: 'red-team', status: 'hold', reason: 'no red-team check run on head' });
const setting = source => ({ value: { source }, sources: { source: 'tool' } });
const pr = () => ({ number: 42, headRefOid: HEAD, labels: [], statusCheckRollup: [{
  __typename: 'CheckRun', name: 'merge-gate', status: 'COMPLETED', conclusion: 'FAILURE',
  detailsUrl: `https://github.com/${REPO}/actions/runs/123/job/${JOB}`,
  startedAt: '2026-11-13T18:59:00Z', completedAt: AT,
}] });
const verdict = () => ({ num: 42, head_sha: HEAD, completed_at: AT, ok: false,
  results: [{ id: 'ledger', status: 'pass', reason: 'clear' }, missing()] });
// The trusted reader must preserve the selected run's metadata as well as its verdict:
// ok/reason alone cannot prove which input changed or when it completed.
const redTeamFact = () => ({ ok: true, reason: 'red-team check run succeeded on head', checkRun: {
  id: 555, name: 'red-team', head_sha: HEAD, status: 'completed', conclusion: 'success',
  completed_at: LATER, external_id: `${REPO}#42`, app: { id: 1234 },
} });
const marker = (head = HEAD, input = 'source:drain-scan') => ({ viewerDidAuthor: true,
  body: `${MARKER}\nhead: ${head}\ninput: ${input}` });
const facts = overrides => ({ verdict: verdict(), setting: setting('drain-scan'),
  redTeamFact: { ok: false, reason: 'no red-team check run on head' }, comments: [], ...overrides });
const plan = (overrides = {}, candidate = pr()) => planMergeGateInputRerun(candidate, facts(overrides));
const empty = () => ({ dispatch: [], refusals: [], applied: [] });

function harness(overrides = {}) {
  const comments = [];
  const events = [];
  const rerunJob = vi.fn(() => { events.push('rerun'); return { ok: true }; });
  const postComment = vi.fn((number, { body }) => {
    events.push('comment');
    comments.push({ id: comments.length + 1, viewerDidAuthor: true, body });
    return { id: comments.length };
  });
  const log = vi.fn();
  const options = { repo: REPO, apply: true, readOpenPrs: () => [pr()],
    readVerdict: () => verdict(), readSetting: () => setting('drain-scan'),
    readRedTeam: () => facts().redTeamFact, readComments: () => comments,
    rerunJob, postComment, now: () => new Date('2026-11-13T20:20:00Z'), log, ...overrides };
  return { options, comments, events, rerunJob, postComment, log,
    run: () => sweepMergeGateInputRerun(options) };
}

afterEach(() => { vi.clearAllMocks(); runGhSync.mockImplementation(() => ''); });

describe('planMergeGateInputRerun', () => {
  it('reruns on source change to drain-scan with only the exact missing-red-team hold', () => {
    expect(plan().dispatch).toEqual([expect.objectContaining({ prNumber: 42, jobId: JOB,
      headSha: HEAD, inputKey: 'source:drain-scan' })]);
  });

  it('reruns on a trusted head red-team result completed after the failing verdict', () => {
    expect(plan({ setting: setting('check-run'), redTeamFact: redTeamFact() }).dispatch)
      .toEqual([expect.objectContaining({ inputKey: 'redteam:555' })]);
  });

  it.each([
    ['other hold', { id: 'ledger', status: 'hold', reason: 'labels: needs review' }],
    ['fail closed', { id: 'red-team', status: 'fail-closed', reason: 'no red-team check run on head' }],
    ['pending red team', { id: 'red-team', status: 'hold', reason: 'red-team check run in progress or incomplete' }],
    ['similar reason', { id: 'red-team', status: 'hold', reason: 'no red-team check run on head (untrusted)' }],
  ])('never reruns a real failure: %s', (_name, row) => {
    expect(plan({ verdict: { ...verdict(), results: [missing(), row] } }).dispatch).toEqual([]);
  });

  it('does not rerun when no input changed', () => {
    expect(plan({ setting: setting('both') }).dispatch).toEqual([]);
  });

  it.each([AT, '2026-11-13T18:59:00Z', null, 'invalid'])('requires a strictly newer red-team completion: %s', completed_at => {
    const fact = redTeamFact();
    fact.checkRun.completed_at = completed_at;
    expect(plan({ setting: setting('both'), redTeamFact: fact }).dispatch).toEqual([]);
  });

  it.each([
    ['unreadable verdict', { error: 'job logs unavailable' }],
    ['absent verdict', null],
    ['stale head', { ...verdict(), head_sha: OTHER_HEAD }],
    ['passing verdict', { ...verdict(), ok: true }],
    ['empty rows', { ...verdict(), results: [] }],
    ['unreadable rows', { ...verdict(), results: null }],
    ['unknown row', { ...verdict(), results: [missing(), { id: 'unknown', status: 'unknown' }] }],
    ['already drain-scan', { ...verdict(), results: [{ id: 'red-team', status: 'pass', reason: 'redTeamGate.source=drain-scan' }] }],
  ])('fails closed for %s', (_name, evidence) => {
    expect(plan({ verdict: evidence }).dispatch).toEqual([]);
  });

  it.each(['SUCCESS', 'CANCELLED', 'TIMED_OUT'])('requires a completed failure, not %s', conclusion => {
    const candidate = pr();
    candidate.statusCheckRollup[0].conclusion = conclusion;
    expect(plan({}, candidate).dispatch).toEqual([]);
  });

  it('does not reuse an older failure superseded by a pending merge-gate', () => {
    const candidate = pr();
    candidate.statusCheckRollup.push({ ...candidate.statusCheckRollup[0], status: 'IN_PROGRESS',
      conclusion: null, startedAt: LATER, completedAt: null });
    expect(plan({}, candidate).dispatch).toEqual([]);
  });

  it('honors an unresolved current-head stand-down (needs-judgment) and does not rerun', () => {
    const stop = { body: buildStandDownComment({ reason: 'needs-judgment', head: HEAD }), createdAt: '2026-11-13T15:00:00Z', author: { login: 'web-everything' }, id: 'IC_hold' };
    const result = plan({ comments: [stop] });
    expect(result.dispatch).toEqual([]);
    expect(result.refusals[0].why).toMatch(/stand-down/);
  });

  it('refuses an exhausted-retry stand-down too (no automatic rerun after exhaustion)', () => {
    const stop = { body: buildStandDownComment({ reason: 'fix-loop-exhausted', head: HEAD }), createdAt: '2026-11-13T15:00:00Z', author: { login: 'web-everything' }, id: 'IC_ex' };
    expect(plan({ comments: [stop] }).dispatch).toEqual([]);
  });

  const loadFlakeHold = () => ({ body: buildLoadFlakeHoldComment({ head: HEAD, alt: 'lane/alt-fix', altSha: 'b'.repeat(40) }),
    createdAt: '2026-11-13T15:00:00Z', author: { login: 'web-everything' }, id: 'IC_lf' });

  it('refuses the rerun while a live load-flake hold is on the current head', () => {
    const result = plan({ comments: [loadFlakeHold()] });
    expect(result.dispatch).toEqual([]);
    expect(result.refusals[0].why).toMatch(/hold|stand-down/);
  });

  it('refuses after reservation when a live load-flake hold appears in the re-read', async () => {
    const h = harness();
    let reads = 0;
    h.options.readComments = () => (++reads === 1 ? h.comments : [...h.comments, loadFlakeHold()]);
    const result = await h.run();
    expect(h.rerunJob).not.toHaveBeenCalled();
    expect(result.refusals.some(r => /hold|stand-down/.test(r.why))).toBe(true);
  });

  it('deduplicates once per head and input using a trusted durable marker', () => {
    expect(plan({ comments: [marker()] }).dispatch).toEqual([]);
    expect(plan({ comments: [marker(OTHER_HEAD)] }).dispatch).toHaveLength(1);
    expect(plan({ comments: [marker(HEAD, 'redteam:555')] }).dispatch).toHaveLength(1);
    expect(plan({ setting: setting('both'), redTeamFact: redTeamFact(),
      comments: [marker(HEAD, 'redteam:555')] }).dispatch).toEqual([]);
  });

  it.each([
    { body: marker().body, user: { login: 'untrusted-contributor' } },
    marker().body,
    { viewerDidAuthor: true, body: `${MARKER}\nhead: ${HEAD}` },
    { viewerDidAuthor: true, body: `${MARKER}\ninput: source:drain-scan` },
  ])('does not accept an untrusted or incomplete marker: %j', comment => {
    expect(plan({ comments: [comment] }).dispatch).toHaveLength(1);
  });

  it('does not treat missing or stale red-team evidence as changed input', () => {
    const fact = redTeamFact();
    fact.checkRun.head_sha = OTHER_HEAD;
    expect(plan({ setting: setting('both'), redTeamFact: fact }).dispatch).toEqual([]);
    expect(plan({ setting: setting('both'), redTeamFact: { ok: true } }).dispatch).toEqual([]);
  });

  it('is pure and leaves the PR and facts unchanged', () => {
    const candidate = pr(), evidence = facts();
    const before = JSON.stringify({ candidate, evidence });
    const first = planMergeGateInputRerun(candidate, evidence);
    expect(planMergeGateInputRerun(candidate, evidence)).toEqual(first);
    expect(JSON.stringify({ candidate, evidence })).toBe(before);
  });
});

describe('sweepMergeGateInputRerun', () => {
  it('refuses an oversized PR listing with an operator fallback before any mutation', () => {
    const h = harness({ readOpenPrs: () => Array.from({ length: 100 }, () => pr()) });
    expect(h.run).toThrow(/100-PR bound; operator must inspect full listing/);
    expect(h.postComment).not.toHaveBeenCalled();
    expect(h.rerunJob).not.toHaveBeenCalled();
  });

  it.each([100, 101])('refuses a capped rollup of %i contexts with an operator fallback and no mutation', count => {
    const candidate = pr();
    candidate.statusCheckRollup.push(...Array.from({ length: count - 1 }, () => ({ name: 'other' })));
    const readVerdict = vi.fn(() => verdict());
    const h = harness({ readOpenPrs: () => [candidate], readVerdict });
    const result = h.run();
    expect(result.dispatch).toEqual([]);
    expect(result.applied).toEqual([]);
    expect(formatMergeGateInputRerunReport(result)).toMatch(/rollup.*100.*operator must inspect/i);
    expect(plan({}, candidate).refusals[0].why).toMatch(/operator must inspect/);
    expect(readVerdict).not.toHaveBeenCalled();
    expect(h.postComment).not.toHaveBeenCalled();
    expect(h.rerunJob).not.toHaveBeenCalled();
  });

  it('refuses an unreadable rollup with an operator fallback before any mutation', () => {
    const candidate = { ...pr(), statusCheckRollup: null };
    const h = harness({ readOpenPrs: () => [candidate] });
    expect(h.run().refusals[0].why).toContain('operator must inspect full checks');
    expect(plan({}, candidate).dispatch).toEqual([]);
    expect(h.postComment).not.toHaveBeenCalled();
    expect(h.rerunJob).not.toHaveBeenCalled();
  });

  it('loses the reservation when a concurrent earlier trusted marker appears on re-read', () => {
    const readComments = vi.fn().mockReturnValueOnce([]).mockImplementation(() => [
      { ...marker(), id: 20 }, { ...marker(), id: 10 },
    ]);
    const h = harness({ readComments, postComment: vi.fn(() => ({ id: 20 })) });
    const result = h.run();
    expect(readComments).toHaveBeenCalledTimes(2);
    expect(result.applied).toEqual([]);
    expect(formatMergeGateInputRerunReport(result)).toContain('lost-reservation');
    expect(h.rerunJob).not.toHaveBeenCalled();
    expect(h.options.postComment).toHaveBeenCalledTimes(1);
  });

  it('only the earliest trusted matching reservation proceeds regardless of array order', () => {
    const readComments = vi.fn().mockReturnValueOnce([]).mockReturnValue([
      { ...marker(), id: 30 }, { ...marker(OTHER_HEAD), id: 1 },
      { ...marker(), id: 2, viewerDidAuthor: false, user: { login: 'untrusted' } },
      { ...marker(HEAD, 'redteam:555'), id: 3 }, { ...marker(), id: 20 },
    ]);
    const h = harness({ readComments, postComment: vi.fn(() => ({ id: 20 })) });
    expect(h.run().applied).toHaveLength(1);
    expect(readComments).toHaveBeenCalledTimes(2);
    expect(h.rerunJob).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])('confirms REST/node identity and creation order (earlier competitor: %s)', earlier => {
    const readComments = vi.fn().mockReturnValueOnce([]).mockReturnValue([
      { ...marker(), id: 'IC_own', node_id: 'IC_own', html_url: 'https://github.com/a/b/issues/42#issuecomment-20', createdAt: AT },
      { ...marker(), id: 'IC_other', createdAt: earlier ? '2026-11-13T18:59:00Z' : LATER },
    ]);
    const h = harness({ readComments, postComment: vi.fn(() => JSON.parse('{"id":20,"node_id":"IC_own"}')) });
    const result = h.run();
    expect(h.rerunJob).toHaveBeenCalledTimes(earlier ? 0 : 1);
    if (earlier) expect(formatMergeGateInputRerunReport(result)).toContain('lost-reservation');
  });

  it('fails closed when competing marker order is ambiguous', () => {
    const readComments = vi.fn().mockReturnValueOnce([]).mockReturnValue([
      { ...marker(), id: 'own', createdAt: AT }, { ...marker(), id: 'other', createdAt: AT },
    ]);
    const h = harness({ readComments, postComment: vi.fn(() => ({ id: 'own' })) });
    expect(h.run().refusals[0].why).toContain('operator must inspect full thread');
    expect(h.rerunJob).not.toHaveBeenCalled();
  });

  it.each([null, [], [{ ...marker() }]])('fails closed on unreadable or unprovable reservation confirmation: %j', confirmation => {
    const readComments = vi.fn().mockReturnValueOnce([]).mockReturnValue(confirmation);
    const h = harness({ readComments });
    const result = h.run();
    expect(result.applied).toEqual([]);
    expect(result.refusals).toHaveLength(1);
    expect(h.rerunJob).not.toHaveBeenCalled();
    expect(h.postComment).toHaveBeenCalledTimes(1);
  });

  it('bounds default GitHub calls across the tick and reports an operator fallback on exhaustion', () => {
    const h = harness({
      readOpenPrs: () => Array.from({ length: 44 }, (_, i) => ({ ...pr(), number: i + 1 })),
      readVerdict: ({ prNumber }) => ({ ...verdict(), num: prNumber }),
    });
    const threads = new Map();
    h.options.readComments = number => threads.get(number) ?? [];
    runGhSync.mockImplementation((args, options) => {
      if (args[0] !== 'pr' || args[1] !== 'comment') return '';
      const number = Number(args[2]);
      const rows = threads.get(number) ?? [];
      const comment = { id: rows.length + 1, viewerDidAuthor: true, body: args[args.indexOf('--body') + 1] };
      rows.push(comment);
      threads.set(number, rows);
      return `https://github.com/a/b/issues/${number}#issuecomment-${comment.id}\n`;
    });
    delete h.options.rerunJob;
    delete h.options.postComment;
    const result = h.run();
    expect(runGhSync).toHaveBeenCalledTimes(128);
    expect(result.applied).toHaveLength(43);
    expect(result.refusals.some(r => /budget exceeded; operator must inspect remaining PRs/.test(r.why))).toBe(true);
    expect(result.applied.some(r => r.prNumber === 44)).toBe(false);
  });

  it('reserves the marker before rerunning only the merge-gate job, then posts its outcome', async () => {
    const h = harness();
    const result = await h.run();
    expect(result.dispatch).toHaveLength(1);
    expect(result.applied).toHaveLength(1);
    expect(h.events).toEqual(['comment', 'rerun', 'comment']);
    expect(h.comments[0].body).toContain(MARKER);
    expect(h.comments[0].body.split('\n')).toContain(`head: ${HEAD}`);
    expect(h.comments[0].body.split('\n')).toContain('input: source:drain-scan');
    expect(h.postComment.mock.calls[0][0]).toBe(42);
    expect(h.rerunJob).toHaveBeenCalledTimes(1);
    expect(h.log.mock.calls.flat()).toContain(
      `merge-gate-input-rerun: PR #42 job ${JOB} rerun (input=source:drain-scan) at 2026-11-13 15:20 ET`);
    expect(formatMergeGateInputRerunReport(result)).toContain('merge-gate-input-rerun');
    await h.run();
    expect(h.rerunJob).toHaveBeenCalledTimes(1);
  });

  it('uses POST repos/<slug>/actions/jobs/<jobId>/rerun through the default transport', async () => {
    const h = harness();
    delete h.options.rerunJob;
    await h.run();
    expect(runGhSync).toHaveBeenCalledTimes(1);
    const args = runGhSync.mock.calls[0][0];
    expect(args[0]).toBe('api');
    expect(args).toContain(`repos/${REPO}/actions/jobs/${JOB}/rerun`);
    expect(args.slice(args.indexOf('-X'), args.indexOf('-X') + 2)).toEqual(['-X', 'POST']);
    expect(args).not.toContain('--failed');
  });

  it('dry-run reports dispatch without reserving or rerunning', async () => {
    const h = harness({ apply: false });
    const result = await h.run();
    expect(result.dispatch).toHaveLength(1);
    expect(result.applied).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it('a failed rerun still counts and its reserved marker prevents the next attempt', async () => {
    const rerunJob = vi.fn(() => { throw new Error('GitHub refused rerun'); });
    const h = harness({ rerunJob });
    const result = await h.run();
    expect(result.applied).toEqual([expect.objectContaining({ ok: false })]);
    expect(h.postComment).toHaveBeenCalledTimes(2);
    expect(h.comments[1].body).toMatch(/fail|refused|error/i);
    await h.run();
    expect(rerunJob).toHaveBeenCalledTimes(1);
  });

  it('never reruns if reservation publication fails', async () => {
    const h = harness({ postComment: vi.fn(() => { throw new Error('comment write denied'); }) });
    // Whether the shell reports or propagates publication failure, no job may start.
    try { await h.run(); } catch (error) { expect(error.message).toContain('comment write denied'); }
    expect(h.rerunJob).not.toHaveBeenCalled();
  });

  it('fails closed when the verdict or durable comment history is unreadable', async () => {
    for (const reader of ['readVerdict', 'readComments']) {
      const h = harness({ [reader]: () => { throw new Error('unreadable evidence'); } });
      try { await h.run(); } catch (error) { expect(error.message).toContain('unreadable evidence'); }
      expect(h.rerunJob).not.toHaveBeenCalled();
      expect(h.postComment).not.toHaveBeenCalled();
    }
  });
});

it('main wires the injected pass after missing-run and includes JSON and text reports', async () => {
  const previousExitCode = process.exitCode;
  try {
    for (const json of [true, false]) {
      const order = [], output = [];
      const result = { ...empty(), dispatch: [{ prNumber: 42, jobId: JOB,
        headSha: HEAD, inputKey: 'source:drain-scan' }] };
      const sweepMergeGateInputRerun = vi.fn(() => { order.push('input-rerun'); return result; });
      await main(['sweep', `--repo=${REPO}`, '--apply', ...(json ? ['--json'] : [])], {
        sweepOptions: { exhaustedRetrySettings: {}, applyLedger: { read: vi.fn(), write: vi.fn() } },
        sweepMainRed: () => ({ ...empty(), mainGreen: null }), sweepExhausted: empty, sweepHung: empty,
        sweepMissingRun: () => { order.push('missing-run'); return empty(); },
        sweepMainCancelled: empty, sweepMergeGateInputRerun,
        writeLine: (fd, body) => output.push({ fd, body }),
        writeAll: (fd, body) => output.push({ fd, body }),
      });
      expect(sweepMergeGateInputRerun).toHaveBeenCalledTimes(1);
      expect(sweepMergeGateInputRerun).toHaveBeenCalledWith(expect.objectContaining({ repo: REPO, apply: true }));
      expect(order).toEqual(['missing-run', 'input-rerun']);
      if (json) {
        const payload = JSON.parse(output.find(line => line.fd === 1).body);
        expect(Object.values(payload)).toContainEqual(result);
      } else {
        expect(output.some(line => line.body.includes(formatMergeGateInputRerunReport(result)))).toBe(true);
      }
    }
  } finally {
    process.exitCode = previousExitCode;
  }
});
