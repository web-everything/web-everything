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
    comments.push({ viewerDidAuthor: true, body });
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

afterEach(() => vi.clearAllMocks());

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

  it('bounds default GitHub calls across the tick and reports an operator fallback on exhaustion', () => {
    const h = harness({
      readOpenPrs: () => Array.from({ length: 44 }, (_, i) => ({ ...pr(), number: i + 1 })),
      readVerdict: ({ prNumber }) => ({ ...verdict(), num: prNumber }),
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
