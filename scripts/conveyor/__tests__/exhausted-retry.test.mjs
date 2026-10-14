import { describe, it, expect, vi } from 'vitest';
import { resolveExhaustedRetry, exhaustionFacts, countExhaustedRetries, planExhaustedRetry,
  buildExhaustedRetryComment, buildExhaustedRetrySpentComment } from '../exhausted-retry.mjs';
import { CI_HEAL_COMMENT_MARKER } from '../ci-heal-mark.mjs';
import { buildStandDownComment, standDownComments } from '../stand-down.mjs';
import { extractInfraSignatures, planMainRedRebases, classifyMainDefect } from '../main-red-recovery.mjs';
import { sweepExhaustedRetry, sweepCiRedRecovery, defaultReadMainFailureSignature } from '../ci-red-recovery-watch.mjs';

const at = '2026-10-14T01:00:00Z';
const later = '2026-10-14T02:00:00Z';
const headSha = 'a'.repeat(40);
const mainSha = 'b'.repeat(40);
const trusted = body => ({ body, createdAt: at, author: { login: 'web-everything' } });
const heals = Array.from({ length: 3 }, () => trusted(CI_HEAL_COMMENT_MARKER));
const settings = () => resolveExhaustedRetry({ env: {}, platform: {}, file: {} });
const facts = { exhausted: true, kind: 'ci-heal-exhausted', at };
const signature = { matched: true, signature: 'test-timeout', mainRunId: 42, mainSha };
const redRun = { databaseId: 42, headSha: mainSha, status: 'completed', conclusion: 'failure', updatedAt: later,
  checkConclusions: { 'daemon-soak': 'failure' } };
const greenRun = { status: 'completed', conclusion: 'success', updatedAt: '2026-10-14T03:00:00Z', checkConclusions: { 'daemon-soak': 'success' } };
const basePlan = extra => planExhaustedRetry({ facts, retriesUsed: 0, settings: settings(), mainTip: { sha: mainSha, committedAt: later },
  aheadBy: 2, now: Date.parse(later), ...extra });

describe('exhausted retry', () => {
  it('resolves standards and per-field cascade sources, rejecting invalid values', () => {
    expect(settings()).toEqual({ enabled: true, onMainMove: true, maxRetries: 1, afterHours: 12, lookbackHours: 72,
      sources: Object.fromEntries(['enabled', 'onMainMove', 'maxRetries', 'afterHours', 'lookbackHours'].map(k => [k, 'standard'])), invalid: [] });
    const s = resolveExhaustedRetry({ env: { WE_EXHAUSTED_RETRY_ENABLED: '0', WE_EXHAUSTED_RETRY_MAX: '2', WE_EXHAUSTED_RETRY_AFTER_HOURS: 'bad' },
      platform: { fixLoop: { exhaustedRetry: { afterHours: 5, onMainMove: false } } }, file: { fixLoop: { exhaustedRetry: { lookbackHours: 24 } } } });
    expect(s).toMatchObject({ enabled: false, maxRetries: 2, afterHours: 5, onMainMove: false, lookbackHours: 24,
      sources: { enabled: 'env', maxRetries: 'env', afterHours: 'platform', lookbackHours: 'tool' } });
    expect(s.invalid.join(' ')).toContain('env.afterHours');
    expect(basePlan({ settings: s }).action).toBe('none');
    expect(basePlan({ settings: { ...settings(), maxRetries: 0 } }).action).toBe('none');
  });
  it('reads both exhaustion kinds using the shared markers and takes the later fact', () => {
    expect(exhaustionFacts({ comments: heals, ciHealCap: 3, headSha })).toEqual(facts);
    const stood = { ...trusted(buildStandDownComment({ reason: 'fix-loop-exhausted', head: headSha })), createdAt: later };
    expect(exhaustionFacts({ comments: [...heals, stood], ciHealCap: 3, headSha })).toEqual({ exhausted: true, kind: 'fix-loop-exhausted', at: later });
    expect(exhaustionFacts({ comments: [stood], ciHealCap: 3, headSha }).kind).toBe('fix-loop-exhausted');
    expect(exhaustionFacts({ comments: [], ciHealCap: 3, headSha }).exhausted).toBe(false);
  });
  it('plans move, age, spent and infra waits', () => {
    expect(basePlan()).toMatchObject({ action: 'retry', mode: 'rebase', trigger: 'main-move' });
    expect(basePlan({ aheadBy: 0 })).toMatchObject({ action: 'wait' });
    expect(basePlan({ aheadBy: 0, now: Date.parse(at) + 12 * 3600000 })).toMatchObject({ action: 'retry', mode: 'rerun', trigger: 'after-hours' });
    expect(basePlan({ retriesUsed: 1 })).toMatchObject({ action: 'needs-you' });
    expect(basePlan({ mainFailureSignature: signature, mainRecoveredForCheck: false })).toMatchObject({ action: 'wait', why: expect.stringContaining('test-timeout') });
    expect(basePlan({ mainFailureSignature: { matched: false, signature: 'test-timeout' }, mainRecoveredForCheck: false })).toMatchObject({ action: 'wait' });
    expect(basePlan({ mainTip: { sha: mainSha, committedAt: at } }).action).toBe('wait');
  });
  it('counts retry markers across heads, without counting spent markers', () => {
    const retry = buildExhaustedRetryComment({ prNumber: 5195, kind: facts.kind, trigger: 'main-move', mode: 'rebase', mainSha, headSha, why: 'moved' });
    const spent = buildExhaustedRetrySpentComment({ kind: facts.kind, check: 'daemon-soak', headSha });
    expect(countExhaustedRetries([trusted(retry), trusted(spent)])).toBe(1);
    expect(spent).toContain(`head: ${headSha}`);
    expect(standDownComments([trusted(spent)])).toHaveLength(1);
  });
  it('live PR #5195, 2026-10-14: retries once and posts the spent handoff once per head', () => {
    const comments = [...heals];
    let currentHead = headSha;
    const refresh = vi.fn(() => { currentHead = 'c'.repeat(40); return { ok: true, action: 'rebased', newCommit: currentHead }; });
    const postComment = vi.fn((n, { body }) => comments.push(trusted(body)));
    const options = { repo: 'web-everything/web-everything', apply: true, settings: settings(), ciHealCap: 3,
      readOpenPrs: () => [{ number: 5195, headRefName: 'lane/5195', headRefOid: currentHead,
        statusCheckRollup: [{ name: 'daemon-soak', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: at }] }],
      readAttributedRequiredChecks: () => ['daemon-soak'], readAheadBy: () => 2, readComments: () => comments,
      readMainRuns: () => [{ ...redRun, updatedAt: '2026-10-14T00:00:00Z' }, greenRun],
      readMainTip: () => ({ sha: mainSha, committedAt: later }), readMainFailureSignature: () => signature,
      refresh, postComment, checkClaim: () => null, readIsCrossRepository: () => false, reconcileAcceptance: () => ({}) };
    expect(sweepExhaustedRetry(options).applied[0].ok).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(countExhaustedRetries(comments)).toBe(1);
    expect(sweepExhaustedRetry(options).refusals[0].kind).toBe('needs-you');
    expect(postComment).toHaveBeenCalledTimes(2);
    sweepExhaustedRetry(options);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(postComment).toHaveBeenCalledTimes(2);
  });
  it('keeps dry runs and failed or held retries free of durable retry markers', () => {
    const c = { prNumber: 5195, headRefName: 'lane/5195', headSha, aheadBy: 2, failureCompletedAt: at, failingCheckName: 'daemon-soak',
      comments: heals, exhaustion: facts, mainFailureSignature: null };
    const postComment = vi.fn(), refresh = vi.fn(() => ({ ok: false, error: 'conflict' }));
    const options = { candidates: [c], mainRuns: [], settings: settings(), ciHealCap: 3, readMainTip: () => ({ sha: mainSha, committedAt: later }),
      checkClaim: () => null, readIsCrossRepository: () => false, refresh, postComment };
    expect(sweepExhaustedRetry(options).dispatch).toHaveLength(1);
    expect(refresh).not.toHaveBeenCalled();
    expect(sweepExhaustedRetry({ ...options, apply: true }).refusals[0].kind).toBe('exhausted-retry-failed');
    expect(postComment).not.toHaveBeenCalled();
    refresh.mockClear();
    sweepExhaustedRetry({ ...options, apply: true, checkClaim: () => ({ message: 'held' }) });
    expect(refresh).not.toHaveBeenCalled();
    expect(postComment).not.toHaveBeenCalled();
  });
  it('triggers fresh CI after the age threshold on a current head', () => {
    const trigger = vi.fn(() => ({ ok: true, action: 'pull-request-push' })), postComment = vi.fn();
    const c = { prNumber: 5195, headRefName: 'lane/5195', headSha, aheadBy: 0, failureCompletedAt: at, failingCheckName: 'daemon-soak',
      comments: heals, exhaustion: facts, mainFailureSignature: null };
    sweepExhaustedRetry({ apply: true, candidates: [c], mainRuns: [], settings: settings(), ciHealCap: 3,
      now: Date.parse(at) + 12 * 3600000, readMainTip: () => ({ sha: mainSha, committedAt: at }),
      checkClaim: () => null, trigger, postComment });
    expect(trigger).toHaveBeenCalledOnce();
    expect(postComment.mock.calls[0][1].body).toContain('fresh CI re-run');
  });
  it('avoids readers when disabled or no PR is red', () => {
    const read = vi.fn(() => { throw Error('unexpected read'); });
    expect(sweepExhaustedRetry({ settings: { ...settings(), enabled: false }, ciHealCap: 3, readOpenPrs: read }).dispatch).toEqual([]);
    expect(sweepExhaustedRetry({ settings: settings(), ciHealCap: 3, readOpenPrs: () => [], readAttributedRequiredChecks: read,
      readAheadBy: read, readComments: read, readMainRuns: read, readMainTip: read, readMainFailureSignature: read }).dispatch).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

});

describe('main failure signatures', () => {
  it('extracts timeout and other infra signatures once each', () => {
    expect(extractInfraSignatures('FAIL scripts/conveyor/__tests__/daemon-soak.test.mjs > baseline > 50 ticks Error: Test timed out in 600000ms.')).toEqual(['test-timeout']);
    expect(extractInfraSignatures('has exceeded the maximum execution time of 6h\nThe runner has received a shutdown signal')).toEqual(['job-time-cap', 'runner-lost']);
  });
  it('waits for main recovery instead of calling a signature match own-failure; absent evidence preserves behavior', () => {
    const c = { prNumber: 5195, failingCheckName: 'daemon-soak', failureCompletedAt: at, aheadBy: 2, mainFailureSignature: signature };
    expect(planMainRedRebases({ candidates: [c], mainRuns: [redRun] }).refusals[0].kind).toBe('main-failure-signature-wait');
    expect(planMainRedRebases({ candidates: [c], mainRuns: [redRun, greenRun] }).dispatch[0].via).toBe('main-failure-signature');
    expect(planMainRedRebases({ candidates: [{ ...c, mainFailureSignature: null }] }).refusals[0].kind).toBe('own-failure');
    expect(classifyMainDefect({ failingCheckName: 'review-gate', prScopedChecks: ['review-gate'], mainFailureSignature: signature }).mainDefect).toBe(false);
  });
  it('reads failed sibling jobs, then newest matching main run, with bounded logs and safe errors', () => {
    const exec = vi.fn((cmd, args) => {
      const endpoint = args[1];
      if (endpoint.includes('/jobs?')) return JSON.stringify({ jobs: [{ id: endpoint.includes('/runs/9/') ? 90 : 420, name: 'soak-shard (1)', conclusion: 'failure' },
        { id: 999, conclusion: 'success' }] });
      return 'Test timed out in 600000ms';
    });
    expect(defaultReadMainFailureSignature({ repo: 'o/r', detailsUrl: 'https://github.com/o/r/actions/runs/9/job/90',
      mainRuns: [redRun], now: Date.parse(greenRun.updatedAt), exec })).toEqual(signature);
    expect(exec).toHaveBeenCalledTimes(4);
    expect(defaultReadMainFailureSignature({ repo: 'o/r', detailsUrl: 'https://github.com/o/r/actions/runs/9', mainRuns: [redRun], exec: () => { throw Error('read'); } })).toBeNull();
  });
  it('reads a signature only after the existing attribution paths refuse; shares exhausted facts', () => {
    const readMainFailureSignature = vi.fn(() => signature), readComments = vi.fn(() => heals), refresh = vi.fn();
    const options = { readOpenPrs: () => [{ number: 5195, headRefName: 'lane/5195', headRefOid: headSha,
      statusCheckRollup: [{ name: 'daemon-soak', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: at }] }],
      readMainRuns: () => [redRun], readAheadBy: () => 2, readAttributedRequiredChecks: () => ['daemon-soak'],
      readMainLatestCheckRuns: () => [], readMainFixedSignatureFacts: () => null, readMainGreenFixFacts: () => ({}), readPriority: () => null,
      readComments, readMainFailureSignature, ciHealCap: 3, refresh };
    expect(sweepCiRedRecovery(options).refusals[0].kind).toBe('main-failure-signature-wait');
    expect(readMainFailureSignature).toHaveBeenCalledOnce();
    readMainFailureSignature.mockClear();
    expect(sweepCiRedRecovery({ ...options, readAheadBy: () => 0 }).refusals[0].kind).toBe('own-failure');
    expect(readMainFailureSignature).not.toHaveBeenCalled();
    readComments.mockClear();
    const red = sweepCiRedRecovery({ ...options, apply: true, exhaustedRetrySettings: settings() });
    expect(red.dispatch).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
    sweepExhaustedRetry({ apply: true, settings: settings(), ciHealCap: 3, candidates: red.candidates, mainRuns: red.mainRuns,
      readMainTip: () => ({ sha: mainSha, committedAt: later }), readMainFailureSignature, readComments });
    expect(readMainFailureSignature).toHaveBeenCalledOnce();
    expect(readComments).toHaveBeenCalledOnce();
  });

  it('caps sibling logs at six and main history at four recent failed runs, newest first', () => {
    const exec = vi.fn((cmd, args) => {
      if (args[1].includes('/jobs?')) {
        const run = Number(/runs\/(\d+)/.exec(args[1])[1]);
        return JSON.stringify({ jobs: Array.from({ length: 10 }, (_, i) => ({ id: run * 100 + i, conclusion: i % 2 ? 'timed_out' : 'failure' })) });
      }
      return args[1].includes('/jobs/90') ? 'Test timed out in 600000ms' : 'lost communication with the server';
    });
    const runs = Array.from({ length: 6 }, (_, i) => ({ ...redRun, databaseId: i + 1, updatedAt: `2026-10-14T0${i}:00:00Z` }));
    runs.push({ ...redRun, databaseId: 100, updatedAt: '2026-10-01T00:00:00Z' });
    expect(defaultReadMainFailureSignature({ repo: 'o/r', detailsUrl: 'https://github.com/o/r/actions/runs/9',
      mainRuns: runs, now: Date.parse('2026-10-14T06:00:00Z'), exec })).toEqual({ matched: false, signature: 'test-timeout' });
    const jobReads = exec.mock.calls.filter(([, args]) => args[1].includes('/jobs?')).map(([, args]) => Number(/runs\/(\d+)/.exec(args[1])[1]));
    expect(jobReads).toEqual([9, 6, 5, 4, 3]);
    expect(exec).toHaveBeenCalledTimes(35);
  });

});
