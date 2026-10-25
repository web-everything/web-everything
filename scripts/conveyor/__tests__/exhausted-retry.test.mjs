import { describe, it, expect, vi } from 'vitest';
import { resolveExhaustedRetry, exhaustionFacts, countExhaustedRetries, planExhaustedRetry,
  buildExhaustedRetryComment, buildExhaustedRetrySpentComment, retryOutcome, realRequiredFailures, wrongSpentStandDowns,
  EXHAUSTED_RETRY_RECOVERED_MARKER, EXHAUSTED_RETRY_SPENT_RESOLVED_MARKER,
  trustedRetryMarkerComments, buildResolvedSpentComment, countBlockingRetryStandDowns } from '../exhausted-retry.mjs';
import { CI_HEAL_COMMENT_MARKER } from '../ci-heal-mark.mjs';
import { planReconcile, resolveCiHealBudget } from '../reconcile-core.mjs';
import { buildFixBeginComment, buildFixEndComment } from '../fix-procedure.mjs';
import { buildStandDownComment, standDownComments, WATCHER_STAND_DOWN_ACTOR, SUPERSEDE_STAND_DOWN_MARKER } from '../stand-down.mjs';
import { buildOperatorAnswer } from '../stand-down-answer-core.mjs';
import { ADVISORY_NOTE_MARKER } from '../advisory-round-count.mjs';
import { ADVISORY_FIX_COMMENT_MARKER } from '../advisory-fix-mark.mjs';
import { extractInfraSignatures, planMainRedRebases, classifyMainDefect } from '../main-red-recovery.mjs';
import { sweepExhaustedRetry, sweepCiRedRecovery, defaultReadMainFailureSignature, defaultEditExhaustedRetryComment, defaultReadPrComments,
  defaultPostExhaustedRetryComment } from '../ci-red-recovery-watch.mjs';
import * as watcher from '../ci-red-recovery-watch.mjs';

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

describe('PR #5331 production wiring and complete threads', () => {
  it.each(['SUCCESS', 'FAILURE', 'ERROR'])('recognizes terminal required StatusContext results after retry: %s', state => {
    const comments = [trusted(buildExhaustedRetryComment({ headSha }))];
    const pr = { headRefOid: headSha, statusCheckRollup: [
      { __typename: 'StatusContext', context: 'external-ci', state, createdAt: later },
    ] };
    expect(retryOutcome({ comments, pr, requiredChecks: ['external-ci'] })).toEqual(
      state === 'SUCCESS' ? { state: 'recovered' } : { state: 'failed', failures: ['external-ci'] });
    pr.statusCheckRollup[0].createdAt = at;
    expect(retryOutcome({ comments, pr, requiredChecks: ['external-ci'] })).toEqual({ state: 'pending' });
    pr.statusCheckRollup[0] = { context: 'external-ci', state: 'PENDING', createdAt: later };
    expect(retryOutcome({ comments, pr, requiredChecks: ['external-ci'] })).toEqual({ state: 'pending' });
    pr.statusCheckRollup[0] = { context: 'external-ci', state, createdAt: 'invalid' };
    expect(retryOutcome({ comments, pr, requiredChecks: ['external-ci'] })).toEqual({ state: 'pending' });
  });

  it('refuses a deferred reservation publication before executing the retry', () => {
    const attempt = vi.fn();
    expect(() => sweepExhaustedRetry({ apply: true, settings: settings(), mainRuns: [],
      candidates: [{ prNumber: 5195, headRefName: 'lane/5195', headSha, aheadBy: 2,
        comments: heals, exhaustion: facts, mainFailureSignature: null }],
      readMainTip: () => ({ sha: mainSha, committedAt: later }), checkClaim: () => null, refresh: attempt,
      postComment: (prNumber, options) => defaultPostExhaustedRetryComment(prNumber,
        { ...options, exec: () => JSON.stringify({ outcome: 'deferred-low-budget' }) }),
    })).toThrow('publication deferred');
    expect(attempt).not.toHaveBeenCalled();
  });

  it('counts a reservation and its outcome once and measures CI from the reservation', () => {
    const reservation = trusted(buildExhaustedRetryComment({ headSha, attemptId: 'attempt-1', reserved: true }));
    const outcome = { ...trusted(buildExhaustedRetryComment({ headSha, attemptId: 'attempt-1' })),
      createdAt: '2026-10-14T03:00:00Z' };
    const pr = { headRefOid: headSha, statusCheckRollup: [{ context: 'external-ci', state: 'SUCCESS', createdAt: later }] };
    expect(countExhaustedRetries([reservation, outcome])).toBe(1);
    expect(countExhaustedRetries([reservation, outcome, trusted(buildExhaustedRetryComment({ headSha }))])).toBe(2);
    expect(retryOutcome({ comments: [reservation, outcome], pr, requiredChecks: ['external-ci'] })).toEqual({ state: 'recovered' });
    expect(retryOutcome({ comments: [reservation], pr, requiredChecks: ['external-ci'] })).toEqual({ state: 'failed', failures: [] });
    // GitHub comment timestamps can tie to the second; the later thread entry wins.
    outcome.createdAt = at;
    expect(retryOutcome({ comments: [reservation, outcome], pr, requiredChecks: ['external-ci'] })).toEqual({ state: 'recovered' });
    expect(retryOutcome({ comments: [reservation, { ...outcome, author: { login: 'outsider' } }], pr,
      requiredChecks: ['external-ci'] })).toEqual({ state: 'failed', failures: [] });
  });

  it('rechecks a claim acquired during reservation publication and retains consumption', () => {
    const comments = [...heals];
    const refresh = vi.fn();
    let claimed = false;
    const options = { apply: true, settings: settings(), mainRuns: [],
      candidates: [{ prNumber: 5195, headRefName: 'lane/5195', headSha, aheadBy: 2,
        comments, exhaustion: facts, mainFailureSignature: null }],
      readMainTip: () => ({ sha: mainSha, committedAt: later }), refresh,
      checkClaim: () => claimed ? { message: 'held' } : null,
      postComment: (n, { body }) => { comments.push(trusted(body)); claimed = true; } };
    expect(sweepExhaustedRetry(options).applied[0]).toMatchObject({ ok: false, deferred: true });
    expect(countExhaustedRetries(comments)).toBe(1);
    claimed = false;
    expect(sweepExhaustedRetry(options).refusals[0].kind).toBe('needs-you');
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([0, 2])('does not repeat an attempt after retry-marker publication fails (ahead=%s)', aheadBy => {
    const comments = [...heals];
    const attempt = vi.fn(() => ({ ok: false, error: 'conflict' }));
    const postComment = vi.fn(() => { throw Error('comment unavailable'); });
    const options = { apply: true, settings: settings(), ciHealCap: 3, mainRuns: [],
      candidates: [{ prNumber: 5195, headRefName: 'lane/5195', headSha, aheadBy, comments,
        exhaustion: facts, mainFailureSignature: null }],
      now: Date.parse(at) + 24 * 3600000, readMainTip: () => ({ sha: mainSha, committedAt: later }),
      checkClaim: () => null, refresh: attempt, trigger: attempt, postComment };
    for (let tick = 0; tick < 3; tick++) {
      try { sweepExhaustedRetry(options); } catch (e) { expect(e.message).toBe('comment unavailable'); }
    }
    expect(attempt).not.toHaveBeenCalled();
  });

  it.each([[0, false], [2, false], [0, true], [2, true]])('retains consumption when the outcome comment fails (ahead=%s, ok=%s)', (aheadBy, ok) => {
    const comments = [...heals];
    let currentHead = headSha;
    const attempt = vi.fn(() => {
      expect(countExhaustedRetries(comments)).toBe(1);
      if (ok) currentHead = 'c'.repeat(40);
      return ok ? { ok: true, newHeadSha: currentHead } : { ok: false, error: 'conflict' };
    });
    const options = { apply: true, settings: settings(), ciHealCap: 3, mainRuns: [],
      readOpenPrs: () => [{ number: 5195, headRefName: 'lane/5195', headRefOid: currentHead,
        statusCheckRollup: [{ context: 'external-ci', state: 'FAILURE', createdAt: at }] }],
      excuseHolds: prs => prs, readAttributedRequiredChecks: () => ['external-ci'],
      readComments: () => comments, readAheadBy: () => aheadBy, readMainFailureSignature: () => null,
      now: Date.parse(at) + 24 * 3600000, readMainTip: () => ({ sha: mainSha, committedAt: later }),
      checkClaim: () => null, refresh: attempt, trigger: attempt,
      postComment: vi.fn((n, { body }) => {
        if (attempt.mock.calls.length) throw Error('outcome unavailable');
        comments.push(trusted(body));
      }) };
    for (let tick = 0; tick < 3; tick++) {
      try { sweepExhaustedRetry({ ...options }); } catch (e) { expect(e.message).toBe('outcome unavailable'); }
    }
    expect(attempt).toHaveBeenCalledOnce();
    expect(countExhaustedRetries(comments)).toBe(1);
  });

  it('keeps an accepted reservation consumed when its acknowledgement is lost', () => {
    const comments = [...heals];
    const refresh = vi.fn();
    const options = { apply: true, settings: settings(), mainRuns: [],
      candidates: [{ prNumber: 5195, headRefName: 'lane/5195', headSha, aheadBy: 2,
        comments, exhaustion: facts, mainFailureSignature: null }],
      readMainTip: () => ({ sha: mainSha, committedAt: later }), checkClaim: () => null, refresh,
      postComment: (n, { body }) => { comments.push(trusted(body)); throw Error('acknowledgement lost'); } };
    expect(() => sweepExhaustedRetry(options)).toThrow('acknowledgement lost');
    expect(countExhaustedRetries(comments)).toBe(1);
    expect(() => sweepExhaustedRetry(options)).toThrow('acknowledgement lost');
    expect(refresh).not.toHaveBeenCalled();
    expect(sweepExhaustedRetry(options).refusals[0].kind).toBe('needs-you');
  });

  const redPr = () => ({ number: 5195, headRefName: 'lane/5195', headRefOid: headSha,
    statusCheckRollup: [{ name: 'daemon-soak', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: at }] });
  const io = () => ({ exhaustedRetrySettings: settings(), settings: settings(), ciHealCap: 3,
    excuseHolds: prs => prs, readOpenPrs: vi.fn(() => [redPr()]),
    readAttributedRequiredChecks: () => ['daemon-soak'], readAheadBy: () => 2,
    readComments: vi.fn(() => heals), readMainRuns: () => [], readMainLatestCheckRuns: () => [],
    readMainGreenFixFacts: () => ({}), readMainFixedSignatureFacts: () => null,
    readMainFailureSignature: vi.fn(() => null), readPriority: () => null,
    readMainTip: () => ({ sha: mainSha, committedAt: later }), checkClaim: () => null,
    refresh: vi.fn(() => ({ ok: false, error: 'conflict' })), postComment: vi.fn() });
  const cli = (sweepOptions, overrides = {}) => ({ sweepOptions, sweepHung: vi.fn(() => ({})),
    sweepMissingRun: vi.fn(() => ({})), writeLine: vi.fn(), writeAll: vi.fn(), ...overrides });

  it.each([0, 2, 3])('signature and exhausted recovery honor unresolved holds with %s heals', healCount => {
    const stop = { ...trusted(buildStandDownComment({ reason: 'needs-judgment', head: headSha })), id: 'IC_hold' };
    const comments = [...heals.slice(0, healCount), stop];
    const options = { ...io(), apply: true, readComments: () => comments,
      readMainRuns: () => [redRun, greenRun], readMainFailureSignature: () => signature };
    const run = () => {
      const first = sweepCiRedRecovery(options);
      sweepExhaustedRetry({ ...options, candidates: first.candidates, mainRuns: first.mainRuns });
    };
    run();
    expect(options.refresh).not.toHaveBeenCalled();
    comments.push(trusted(buildOperatorAnswer({ standDownId: stop.id, reason: 'Proceed with the retry', actor: 'chalbert', channel: 'Codex chat' })));
    run();
    expect(options.refresh).toHaveBeenCalledOnce();
  });

  it.each(['green-fix', 'signature'])('CLI preserves %s ownership and the per-head cap', async via => {
    const options = io();
    if (via === 'green-fix') {
      options.readMainLatestCheckRuns = () => [{ head_sha: mainSha, name: 'daemon-soak', conclusion: 'success', status: 'completed' }];
      options.readMainGreenFixFacts = () => ({ prContainsMainGreenSha: false, mergeBaseCheckRuns: [], mergeBaseRunConclusion: 'success' });
    } else {
      options.readMainFixedSignatureFacts = () => ({ signatures: [{ emitterFiles: ['test.mjs'], fixCommits: [mainSha] }] });
    }
    options.maxRebaseRetriesPerSha = 0;
    const sweepExhausted = vi.fn(sweepExhaustedRetry);
    const calls = cli(options, { sweepExhausted });
    await watcher.main(['sweep', '--apply', '--json'], calls);
    const result = JSON.parse(calls.writeAll.mock.calls[0][1]);
    expect(result.mainRedRecovery.candidates[0].mainRecoveryOwned).toBe(true);
    expect(sweepExhausted.mock.calls[0][0].candidates).toBeDefined();
    expect(result.exhaustedRetry.dispatch).toEqual([]);
    expect(options.refresh).not.toHaveBeenCalled();
    expect(options.readOpenPrs).toHaveBeenCalledOnce();
    expect(options.readComments).toHaveBeenCalledOnce();
    expect(options.readMainFailureSignature).not.toHaveBeenCalled();
  });

  it.each(['readMainTip', 'postComment', 'editComment', 'main-red', 'hung'])('CLI continues after a throwing %s', async failure => {
    const options = io();
    const calls = cli(options);
    const boom = () => { throw Error('transient read/write failure'); };
    if (failure === 'main-red') calls.sweepMainRed = boom;
    else if (failure === 'hung') calls.sweepHung = vi.fn(boom);
    else if (failure === 'editComment') {
      const pr = redPr();
      pr.statusCheckRollup[0] = { ...pr.statusCheckRollup[0], conclusion: 'SUCCESS', completedAt: later };
      options.readOpenPrs = () => [pr];
      options.readComments = () => [...heals, trusted(buildExhaustedRetrySpentComment({ headSha }))];
      options.editComment = boom;
    } else options[failure] = boom;
    const previousExitCode = process.exitCode;
    try {
      await watcher.main(['sweep', '--apply', '--json'], calls);
      expect(calls.sweepHung).toHaveBeenCalledOnce();
      expect(calls.sweepMissingRun).toHaveBeenCalledOnce();
      expect(calls.writeLine.mock.calls.flat().join(' ')).toContain('transient read/write failure');
      expect(process.exitCode).toBe(1);
    } finally { process.exitCode = previousExitCode; }
  });

  it.each(['truncated', 'stale'])('ignores %s discovery comments for retry and handoff budgets', mode => {
    const comments = [...heals, trusted(buildExhaustedRetryComment({ headSha, ok: false })),
      trusted(buildExhaustedRetrySpentComment({ headSha }))];
    const pr = { ...redPr(), comments: mode === 'truncated'
      ? [...heals, ...Array.from({ length: 97 }, () => trusted('old discussion'))] : heals };
    const options = { ...io(), apply: true, readOpenPrs: vi.fn(() => [pr]), readComments: vi.fn(() => comments) };
    for (let tick = 0; tick < 3; tick++) {
      expect(sweepExhaustedRetry(options).refusals[0].kind).toBe('needs-you');
    }
    expect(options.refresh).not.toHaveBeenCalled();
    expect(options.postComment).not.toHaveBeenCalled();
    expect(options.readComments).toHaveBeenCalledTimes(3);
    expect(options.readOpenPrs.mock.calls[0][0].extraFields).not.toContain('comments');
  });

  it('uses the fresh thread for recovery deduplication and stand-down edits', () => {
    const retry = trusted(buildExhaustedRetryComment({ headSha }));
    const spent = { ...trusted(buildExhaustedRetrySpentComment({ headSha })), id: 'IC_stale' };
    const recovered = { ...trusted(`${EXHAUSTED_RETRY_RECOVERED_MARKER}\nhead: ${headSha}`), createdAt: later };
    const pr = { ...redPr(), comments: [...heals, retry, spent] };
    pr.statusCheckRollup[0] = { ...pr.statusCheckRollup[0], conclusion: 'SUCCESS', completedAt: later };
    const options = { ...io(), apply: true, readOpenPrs: () => [pr], editComment: vi.fn(),
      readComments: vi.fn(() => [...heals, retry, { ...spent, body: buildResolvedSpentComment(spent, headSha) }, recovered]) };
    sweepExhaustedRetry(options);
    expect(options.readComments).toHaveBeenCalledOnce();
    expect(options.postComment).not.toHaveBeenCalled();
    expect(options.editComment).not.toHaveBeenCalled();
  });

  it('CLI still publishes recovery when all required checks have gone green', async () => {
    const options = io();
    const pr = redPr();
    pr.statusCheckRollup[0] = { ...pr.statusCheckRollup[0], conclusion: 'SUCCESS', completedAt: later };
    options.readOpenPrs = vi.fn(() => [pr]);
    options.readComments = vi.fn(() => [...heals, trusted(buildExhaustedRetryComment({ headSha }))]);
    const calls = cli(options);
    await watcher.main(['sweep', '--apply', '--json'], calls);
    expect(options.postComment).toHaveBeenCalledOnce();
    expect(options.postComment.mock.calls[0][1].body).toContain(EXHAUSTED_RETRY_RECOVERED_MARKER);
    expect(options.readOpenPrs).toHaveBeenCalledOnce();
  });
});

describe('exhausted retry', () => {
  it('shares stand-down trust, lapse and resolution rules without losing comment identity', () => {
    const stop = { ...trusted(buildStandDownComment({ reason: 'needs-judgment', head: headSha })), id: 'IC_hold' };
    const answer = trusted(buildOperatorAnswer({ standDownId: stop.id, reason: 'Proceed', actor: 'chalbert', channel: 'Codex chat' }));
    expect(countBlockingRetryStandDowns([stop], headSha)).toBe(1);
    expect(countBlockingRetryStandDowns([stop, answer], headSha)).toBe(0);
    expect(countBlockingRetryStandDowns([stop, { ...answer, author: { login: 'outsider' } }], headSha)).toBe(1);
    expect(countBlockingRetryStandDowns([stop], mainSha)).toBe(0);
    expect(countBlockingRetryStandDowns([{ ...stop, author: { login: 'outsider' } }], headSha)).toBe(0);
    const watcherStop = trusted(buildStandDownComment({ actor: WATCHER_STAND_DOWN_ACTOR, reason: 'conflict', head: headSha }));
    expect(countBlockingRetryStandDowns([watcherStop, trusted(SUPERSEDE_STAND_DOWN_MARKER)], headSha)).toBe(0);
    expect(countBlockingRetryStandDowns([trusted(ADVISORY_NOTE_MARKER), trusted(ADVISORY_FIX_COMMENT_MARKER), stop], headSha)).toBe(0);
    expect(countBlockingRetryStandDowns([trusted(buildStandDownComment({ reason: 'superseded', head: mainSha }))], headSha)).toBe(1);
    expect(countBlockingRetryStandDowns([trusted(buildStandDownComment({ reason: 'needs-judgment' }))], headSha)).toBe(1);
    for (const [reason, head] of [['fix-loop-exhausted', headSha], ['needs-judgment', mainSha]]) {
      const newer = { ...trusted(buildStandDownComment({ reason, head })), id: 'IC_newer' };
      const resolveNewer = trusted(buildOperatorAnswer({ standDownId: newer.id, reason: 'Proceed', actor: 'chalbert', channel: 'Codex chat' }));
      expect(countBlockingRetryStandDowns([stop, newer, resolveNewer], headSha)).toBe(0);
    }
  });

  it.each(['needs-judgment', 'superseded'])('preserves an active %s hold across retry modes and exhaustion kinds', reason => {
    for (const aheadBy of [0, 2]) {
      for (const exhaustion of [heals, [trusted(buildStandDownComment({ reason: 'fix-loop-exhausted', head: headSha }))]]) {
        const comments = [...exhaustion, trusted(buildStandDownComment({ reason, head: headSha }))];
        const refresh = vi.fn(() => ({ ok: true, newCommit: 'c'.repeat(40) }));
        const trigger = vi.fn(() => ({ ok: true }));
        const postComment = vi.fn();
        const result = sweepExhaustedRetry({ apply: true, settings: settings(), ciHealCap: 3,
          candidates: [{ prNumber: 5195, headSha, aheadBy, comments, mainFailureSignature: null }], mainRuns: [],
          now: Date.parse(at) + 24 * 3600000, readMainTip: () => ({ sha: mainSha, committedAt: later }),
          checkClaim: () => null, refresh, trigger, postComment, reconcileAcceptance: () => ({}) });
        expect(refresh).not.toHaveBeenCalled();
        expect(trigger).not.toHaveBeenCalled();
        expect(postComment).not.toHaveBeenCalled();
        expect(result.dispatch).toEqual([]);
        expect(result.refusals[0]).toMatchObject({ kind: 'stand-down' });
      }
    }
  });

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
    expect(basePlan({ retriesUsed: 1, outcome: { state: 'failed' } })).toMatchObject({ action: 'needs-you' });
    expect(basePlan({ outcome: { state: 'pending' }, headSha })).toMatchObject({ action: 'wait' });
    expect(basePlan({ retriesUsed: 1, outcome: { state: 'recovered' } })).toMatchObject({ action: 'none' });
    expect(basePlan({ mainFailureSignature: signature, mainRecoveredForCheck: false })).toMatchObject({ action: 'wait', why: expect.stringContaining('test-timeout') });
    expect(basePlan({ mainFailureSignature: { matched: false, signature: 'test-timeout' }, mainRecoveredForCheck: false })).toMatchObject({ action: 'wait' });
    expect(basePlan({ mainTip: { sha: mainSha, committedAt: at } }).action).toBe('wait');
  });
  it('counts retry markers across heads, without counting spent markers', () => {
    const retry = buildExhaustedRetryComment({ prNumber: 5195, kind: facts.kind, trigger: 'main-move', mode: 'rebase', mainSha, headSha, why: 'moved' });
    const spent = buildExhaustedRetrySpentComment({ kind: facts.kind, check: 'daemon-soak', headSha });
    expect(countExhaustedRetries([trusted(retry), trusted(spent)])).toBe(1);
    expect(countExhaustedRetries([{ ...trusted(retry), author: { login: 'outsider' } }])).toBe(0);
    expect(spent).toContain(`head: ${headSha}`);
    expect(standDownComments([trusted(spent)])).toHaveLength(1);
  });
  it('live PR #5195, 2026-10-14: retries once and posts the spent handoff once per head', () => {
    const comments = [...heals];
    let currentHead = headSha;
    const refresh = vi.fn(() => { currentHead = 'c'.repeat(40); return { ok: true, action: 'rebased', newCommit: currentHead }; });
    const postComment = vi.fn((n, { body }) => comments.push(trusted(body)));
    const options = { excuseHolds: prs => prs, repo: 'web-everything/web-everything', apply: true, settings: settings(), ciHealCap: 3,
      readOpenPrs: () => [{ number: 5195, headRefName: 'lane/5195', headRefOid: currentHead,
        statusCheckRollup: [{ name: 'daemon-soak', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: currentHead === headSha ? at : '2026-10-14T04:00:00Z' }] }],
      readAttributedRequiredChecks: () => ['daemon-soak'], readAheadBy: () => 2, readComments: () => comments,
      readMainRuns: () => [redRun, greenRun],
      readMainTip: () => ({ sha: mainSha, committedAt: later }), readMainFailureSignature: () => signature,
      refresh, postComment, checkClaim: () => null, readIsCrossRepository: () => false, reconcileAcceptance: () => ({}) };
    expect(sweepExhaustedRetry(options).applied[0].ok).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(countExhaustedRetries(comments)).toBe(1);
    expect(sweepExhaustedRetry(options).refusals[0].kind).toBe('needs-you');
    expect(postComment).toHaveBeenCalledTimes(3);
    sweepExhaustedRetry(options);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(postComment).toHaveBeenCalledTimes(3);
  });
  it('counts failed retry attempts durably, but leaves dry runs and claim holds free', () => {
    const c = { prNumber: 5195, headRefName: 'lane/5195', headSha, aheadBy: 2, failureCompletedAt: at, failingCheckName: 'daemon-soak',
      comments: [...heals], exhaustion: facts, mainFailureSignature: null };
    const postComment = vi.fn((n, { body }) => c.comments.push(trusted(body)));
    const refresh = vi.fn(() => ({ ok: false, error: 'conflict' }));
    const options = { candidates: [c], mainRuns: [], settings: settings(), ciHealCap: 3, readMainTip: () => ({ sha: mainSha, committedAt: later }),
      checkClaim: () => null, readIsCrossRepository: () => false, refresh, postComment };
    expect(sweepExhaustedRetry(options).dispatch).toHaveLength(1);
    expect(refresh).not.toHaveBeenCalled();
    expect(sweepExhaustedRetry({ ...options, apply: true }).refusals[0].kind).toBe('exhausted-retry-failed');
    expect(countExhaustedRetries(c.comments)).toBe(1);
    expect(postComment.mock.calls[0][1].body).toContain('retry-result: reserved');
    expect(postComment.mock.calls[1][1].body).toContain('retry-result: failed');
    expect(sweepExhaustedRetry({ ...options, apply: true }).refusals[0].kind).toBe('needs-you');
    expect(refresh).toHaveBeenCalledOnce();
    c.comments = [...heals];
    postComment.mockClear();
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
    expect(sweepExhaustedRetry({ settings: { ...settings(), enabled: false }, ciHealCap: 3, readOpenPrs: read, excuseHolds: prs => prs }).dispatch).toEqual([]);
    expect(sweepExhaustedRetry({ settings: settings(), ciHealCap: 3, readOpenPrs: () => [], excuseHolds: prs => prs, readAttributedRequiredChecks: read,
      readAheadBy: read, readComments: read, readMainRuns: read, readMainTip: read, readMainFailureSignature: read }).dispatch).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([true, false])('matches reconciler exhaustion across fixer head resets (reset=%s)', resetOnFixHead => {
    const fix = [trusted(buildFixBeginComment({ who: 'fix-5195', why: 'repair', branch: 'lane/5195', headSha })),
      { ...trusted(buildFixEndComment({ who: 'fix-5195', headSha: 'c'.repeat(40) })), createdAt: later }];
    const ciHealBudget = resolveCiHealBudget({ repo: { resetOnFixHead } });
    for (const comments of [heals, [...heals, ...fix], [...heals, ...fix, ...heals.map(c => ({ ...c, createdAt: '2026-10-14T04:00:00Z' }))]]) {
      const plan = planReconcile({ prs: [{ number: 5195, state: 'OPEN', headRefOid: 'c'.repeat(40),
        mergeStateStatus: 'CLEAN', labels: [{ name: 'ci:failed' }], comments,
        statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }] }],
        agents: [], ciHealBudget, now: Date.parse('2026-10-14T05:00:00Z') });
      expect(exhaustionFacts({ comments, ciHealBudget, headSha: 'c'.repeat(40) }).exhausted)
        .toBe(plan.notes.some(n => n.kind === 'ci-heal-exhausted'));
    }
    const priorStandDown = trusted(buildStandDownComment({ reason: 'fix-loop-exhausted', head: headSha }));
    expect(exhaustionFacts({ comments: [priorStandDown, ...fix], ciHealBudget, headSha: 'c'.repeat(40) }).exhausted)
      .toBe(false);
  });

  it('lapses old fix-loop holds on unrelated heads, but hands off on the recorded mechanical retry head', () => {
    const comments = [trusted(buildStandDownComment({ reason: 'fix-loop-exhausted', head: headSha }))];
    let currentHead = headSha;
    const retryHead = 'c'.repeat(40);
    const refresh = vi.fn(() => { currentHead = retryHead; return { ok: true, action: 'rebased', newCommit: retryHead }; });
    const postComment = vi.fn((n, { body }) => comments.push({ ...trusted(body), createdAt: later }));
    const options = { apply: true, settings: settings(), ciHealCap: 3,
      readOpenPrs: () => [{ number: 5195, headRefName: 'lane/5195', headRefOid: currentHead,
        statusCheckRollup: [{ name: 'daemon-soak', status: 'COMPLETED', conclusion: 'FAILURE',
          completedAt: currentHead === headSha ? at : '2026-10-14T04:00:00Z' }] }],
      readAttributedRequiredChecks: () => ['daemon-soak'], readAheadBy: () => 2, readComments: () => comments,
      readMainRuns: () => [], readMainTip: () => ({ sha: mainSha, committedAt: later }), readMainFailureSignature: () => null,
      refresh, postComment, checkClaim: () => null, reconcileAcceptance: () => ({}) };
    sweepExhaustedRetry(options);
    expect(comments[1].body).toContain('retry-result: reserved');
    expect(comments[2].body).toContain(`retry-head: ${retryHead}`);
    expect(sweepExhaustedRetry(options).refusals[0].kind).toBe('needs-you');
    expect(refresh).toHaveBeenCalledOnce();
    expect(standDownComments(comments, { headRefOid: retryHead, lapseOnNewHead: 'on' })).toHaveLength(1);
    currentHead = 'd'.repeat(40); // manual push, without fix-begin/fix-end
    expect(standDownComments(comments, { headRefOid: currentHead, lapseOnNewHead: 'on' })).toHaveLength(0);
    expect(exhaustionFacts({ comments, headSha: currentHead, lapseOnNewHead: 'on' }).exhausted).toBe(false);
    expect(exhaustionFacts({ comments, headSha: currentHead, lapseOnNewHead: 'off' }).exhausted).toBe(true);
    expect(sweepExhaustedRetry(options).refusals).toEqual([]);
    expect(postComment).toHaveBeenCalledTimes(3);
    const forged = comments.map(c => c.body.includes(`retry-head: ${retryHead}`) ? { ...c, author: { login: 'outsider' } } : c);
    expect(exhaustionFacts({ comments: forged, headSha: retryHead, lapseOnNewHead: 'on' }).exhausted).toBe(false);
  });

  it.each([true, false])('bounds thrown and refused attempts across sweeps (throw=%s)', throws => {
    const comments = [...heals];
    const refresh = vi.fn(() => { if (throws) throw Error('push refused'); return { ok: false, error: 'push refused' }; });
    const options = { apply: true, settings: settings(), candidates: [{ prNumber: 5195, headRefName: 'lane/5195', headSha,
      aheadBy: 2, comments, exhaustion: facts, mainFailureSignature: null }], mainRuns: [],
      readMainTip: () => ({ sha: mainSha, committedAt: later }), refresh, checkClaim: () => null,
      postComment: (n, { body }) => comments.push(trusted(body)) };
    sweepExhaustedRetry(options);
    expect(sweepExhaustedRetry(options).refusals[0].kind).toBe('needs-you');
    sweepExhaustedRetry(options);
    expect(refresh).toHaveBeenCalledOnce();
    expect(standDownComments(comments)).toHaveLength(1);
  });

  it('ignores forged spent handoffs and quoted retry markers', () => {
    const retry = trusted(buildExhaustedRetryComment({ headSha }));
    expect(countExhaustedRetries([trusted(`quoted\n${retry.body}`), retry.body, { body: retry.body }])).toBe(0);
    const comments = [...heals, retry, { ...trusted(buildExhaustedRetrySpentComment({ headSha })), author: { login: 'outsider' } }];
    const postComment = vi.fn();
    sweepExhaustedRetry({ apply: true, settings: settings(), mainRuns: [], candidates: [{ prNumber: 5195, headSha, aheadBy: 2,
      comments, exhaustion: facts, mainFailureSignature: null }], readMainTip: () => ({ sha: mainSha, committedAt: later }), postComment });
    expect(postComment).toHaveBeenCalledOnce();
  });

  it.each([true, false])('checks signature matching against age expiry without later main runs (matched=%s)', matched => {
    for (const elapsed of [false, true]) {
      const decision = basePlan({ mainFailureSignature: { matched, signature: 'test-timeout' }, mainRecoveredForCheck: false,
        aheadBy: 0, mainTip: { sha: mainSha, committedAt: at }, now: Date.parse(at) + (elapsed ? 12 : 11) * 3600000 });
      expect(decision.action).toBe(!matched && elapsed ? 'retry' : 'wait');
    }
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

  it.each([{ enabled: false }, { maxRetries: 0 }])('disabling retries preserves own-failure decisions (%j)', disabled => {
    const readMainFailureSignature = vi.fn(() => signature), refresh = vi.fn();
    const result = sweepCiRedRecovery({ apply: true, exhaustedRetrySettings: { ...settings(), ...disabled },
      readOpenPrs: () => [{ number: 5195, headRefName: 'lane/5195', headRefOid: headSha,
        statusCheckRollup: [{ name: 'daemon-soak', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: at }] }],
      readMainRuns: () => [redRun, greenRun], readAheadBy: () => 2,
      readAttributedRequiredChecks: () => ['daemon-soak'], readMainLatestCheckRuns: () => [], readMainGreenFixFacts: () => ({}),
      readMainFixedSignatureFacts: () => null, readPriority: () => null, readComments: () => heals, readMainFailureSignature, refresh });
    expect(result.refusals[0].kind).toBe('own-failure');
    expect(readMainFailureSignature).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('keeps exhausted main-red PRs on the existing recovery path, before and after main recovers', () => {
    const failureAt = '2026-10-14T02:30:00Z';
    for (const recovered of [false, true]) {
      const options = { readOpenPrs: () => [{ number: 5195, headRefName: 'lane/5195', headRefOid: headSha,
        statusCheckRollup: [{ name: 'daemon-soak', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: failureAt }] }],
        readMainRuns: () => recovered ? [redRun, greenRun] : [redRun], readAheadBy: () => 2,
        readAttributedRequiredChecks: () => ['daemon-soak'], readMainLatestCheckRuns: () => [], readPriority: () => null,
        readComments: () => heals };
      const old = sweepCiRedRecovery(options);
      const exhausted = sweepCiRedRecovery({ ...options, exhaustedRetrySettings: settings() });
      expect(exhausted.dispatch).toEqual(old.dispatch);
      expect(exhausted.refusals).toEqual(old.refusals);
      expect(recovered ? exhausted.dispatch[0].kind : exhausted.refusals[0].kind).toBe(recovered ? 'rebase-onto-main' : 'main-still-red');
      const retry = sweepExhaustedRetry({ settings: settings(), candidates: exhausted.candidates, mainRuns: exhausted.mainRuns,
        now: Date.parse(at) + 24 * 3600000, readMainTip: () => ({ sha: mainSha, committedAt: later }), readMainFailureSignature: () => null });
      expect(retry.dispatch).toEqual([]);
    }
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

// Regression: live PR #5169, 2026-10-14 — green CI plus a human-review HOLD.
describe('retried CI verdicts', () => {
  const sha = 'fcf351d' + '0'.repeat(33);
  const required = ['test', 'smoke', 'daemon-soak', 'integration', 'merge-gate', 'review-gate'];
  const retry = { ...trusted(buildExhaustedRetryComment({ kind: facts.kind })), createdAt: later };
  const green = () => ({ number: 5169, headRefName: 'lane/5169', headRefOid: sha, labels: [{ name: 'review:human' }],
    statusCheckRollup: required.map(name => ({ name, status: 'COMPLETED', completedAt: '2026-10-14T03:00:00Z',
      conclusion: name.endsWith('gate') ? 'FAILURE' : 'SUCCESS' })) });
  const fixture = (pr = green(), initial = [...heals, retry]) => {
    const comments = [...initial];
    const postComment = vi.fn((n, { body }) => comments.push({ ...trusted(body), createdAt: '2026-10-14T04:00:00Z' }));
    const editComment = vi.fn((id, { body }) => { comments.find(c => c.id === id).body = body; });
    const unexpected = () => { throw Error('unexpected IO'); };
    const options = { apply: true, settings: settings(), ciHealCap: 3, readOpenPrs: () => [pr],
      excuseHolds: vi.fn(prs => prs.map(p => ({ ...p, statusCheckRollup: p.statusCheckRollup.map(row =>
        row.name === 'merge-gate' ? { ...row, mergeGateReviewHold: { holds: ['review-acceptance'] } } : row) }))),
      readAttributedRequiredChecks: () => required, readComments: () => comments, postComment, editComment,
      readAheadBy: () => 2, readMainRuns: () => [], readMainTip: () => ({ sha: mainSha, committedAt: later }),
      readMainFailureSignature: () => null, refresh: unexpected, trigger: unexpected, checkClaim: unexpected,
      reconcileAcceptance: unexpected, readIsCrossRepository: unexpected };
    return { options, comments, postComment, editComment };
  };
  it('records recovery once for green CI with review holds', () => {
    const f = fixture();
    sweepExhaustedRetry(f.options);
    expect(f.postComment).toHaveBeenCalledOnce();
    expect(f.comments.at(-1).body).toContain(EXHAUSTED_RETRY_RECOVERED_MARKER);
    expect(f.comments.at(-1).body).toContain(`head: ${sha}`);
    sweepExhaustedRetry(f.options);
    expect(f.postComment).toHaveBeenCalledOnce();
  });
  it('excludes human review-gate failures but retains unannotated merge-gate failures', () => {
    const pr = green();
    expect(realRequiredFailures(pr, required)).toEqual(['merge-gate']);
    pr.labels = ['review:pending'];
    expect(realRequiredFailures(pr, ['review-gate'])).toEqual([]);
    pr.labels = [];
    expect(realRequiredFailures(pr, ['review-gate'])).toEqual(['review-gate']);
  });
  it('waits for pending, missing and pre-retry rows on the current head', () => {
    const pr = green();
    pr.statusCheckRollup[0].status = 'IN_PROGRESS';
    const f = fixture(pr);
    expect(sweepExhaustedRetry(f.options).refusals[0]).toMatchObject({ action: 'wait', why: `the retried CI run has not finished on ${sha.slice(0, 7)}` });
    expect(f.postComment).not.toHaveBeenCalled();
    expect(retryOutcome({ comments: [retry], pr, requiredChecks: required })).toEqual({ state: 'pending' });
    pr.statusCheckRollup.shift();
    expect(retryOutcome({ comments: [retry], pr, requiredChecks: required })).toEqual({ state: 'pending' });
    pr.statusCheckRollup = green().statusCheckRollup.map(row => ({ ...row, completedAt: at }));
    expect(retryOutcome({ comments: [retry], pr, requiredChecks: required })).toEqual({ state: 'pending' });
    expect(retryOutcome({ comments: [], pr, requiredChecks: required })).toBeNull();
  });
  it('posts spent once only for completed real failures, with the lapse trailer last', () => {
    const pr = green();
    pr.statusCheckRollup.find(row => row.name === 'daemon-soak').conclusion = 'FAILURE';
    const f = fixture(pr);
    sweepExhaustedRetry(f.options);
    expect(f.postComment).toHaveBeenCalledOnce();
    expect(f.comments.at(-1).body.split('\n').at(-1)).toBe(`<!-- stand-down reason=exhausted-retry-spent head=${sha} -->`);
    sweepExhaustedRetry(f.options);
    expect(f.postComment).toHaveBeenCalledOnce();
  });
  it('edits its erroneous spent stand-down once and records recovery', () => {
    const spent = { ...trusted(buildExhaustedRetrySpentComment({ kind: facts.kind, check: 'merge-gate', headSha: sha }).split('\n').slice(0, -1).join('\n')), id: 'IC_spent' };
    const f = fixture(green(), [...heals, retry, spent]);
    expect(sweepExhaustedRetry(f.options).applied).toContainEqual(expect.objectContaining({ kind: 'spent-stand-down-resolved' }));
    expect(f.editComment).toHaveBeenCalledOnce();
    expect(f.editComment.mock.calls[0][1].body.startsWith(EXHAUSTED_RETRY_SPENT_RESOLVED_MARKER)).toBe(true);
    expect(f.editComment.mock.calls[0][1].body).toContain('> <!-- we:exhausted-retry-spent -->');
    expect(standDownComments(f.comments)).toHaveLength(0);
    expect(f.postComment).toHaveBeenCalledOnce();
    sweepExhaustedRetry(f.options);
    expect(f.editComment).toHaveBeenCalledOnce();
    expect(f.postComment).toHaveBeenCalledOnce();
    expect(wrongSpentStandDowns({ comments: f.comments, pr: green(), requiredChecks: required })).toEqual([]);
  });
  it('never retries a review hold without real required failures', () => {
    const f = fixture(green(), heals);
    expect(sweepExhaustedRetry(f.options)).toMatchObject({ dispatch: [], refusals: [], applied: [] });
    expect(f.postComment).not.toHaveBeenCalled();
    expect(f.options.excuseHolds).toHaveBeenCalledOnce();
  });
  it('uses latest rows and treats excused merge-gate as a hold even if still red', () => {
    const pr = green();
    pr.statusCheckRollup.find(row => row.name === 'merge-gate').mergeGateHoldExcused = { kind: 'candidacy' };
    pr.statusCheckRollup.unshift({ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: at });
    expect(realRequiredFailures(pr, required)).toEqual([]);
    expect(retryOutcome({ comments: [retry], pr, requiredChecks: required })).toEqual({ state: 'recovered' });
    pr.statusCheckRollup.find(row => row.name === 'daemon-soak').conclusion = 'FAILURE';
    expect(retryOutcome({ comments: [retry], pr, requiredChecks: required })).toEqual({ state: 'failed', failures: ['daemon-soak'] });
    expect(wrongSpentStandDowns({ comments: [trusted(buildExhaustedRetrySpentComment({ headSha: sha }))], pr, requiredChecks: required })).toEqual([]);
  });
  it('preserves the node id in the reader and sends the edit via GraphQL', () => {
    const comment = { ...trusted('original'), id: 'IC_spent' };
    const read = vi.fn((_file, args) => args[1] === 'graphql'
      ? JSON.stringify({ data: { repository: { pullRequest: { comments: { totalCount: 1 } } } } })
      : `${comment.body}\t${comment.createdAt}\t${comment.author.login}\t${comment.id}\n`);
    expect(defaultReadPrComments(5169, { repo: 'o/r', exec: read })).toEqual([comment]);
    expect(read.mock.calls[0][1]).toContain('--paginate');
    expect(() => defaultReadPrComments(5169, { repo: 'o/r', exec: () => { throw Error('unreadable'); } })).toThrow('unreadable');
    const exec = vi.fn(() => JSON.stringify({ data: { updateIssueComment: { issueComment: { id: comment.id } } } }));
    defaultEditExhaustedRetryComment(comment.id, { repo: 'o/r', body: 'resolved', exec });
    expect(exec.mock.calls[0][1]).toEqual(['api', 'graphql', '-f',
      'query=mutation($id:ID!,$body:String!){updateIssueComment(input:{id:$id,body:$body}){issueComment{id}}}',
      '-f', 'id=IC_spent', '-f', 'body=resolved']);
    expect(() => defaultEditExhaustedRetryComment(comment.id, { body: 'resolved', exec: () => '{"errors":[{"message":"denied"}]}' })).toThrow('could not resolve');
  });
  it('keeps exhaustion and retry budgets spent after recovery, matching the reconciler', () => {
    const recovered = { ...trusted(EXHAUSTED_RETRY_RECOVERED_MARKER), createdAt: '2026-10-14T04:00:00Z' };
    const stood = trusted(buildStandDownComment({ reason: 'fix-loop-exhausted', head: sha }));
    const comments = [...heals, stood, retry, recovered];
    expect(exhaustionFacts({ comments, ciHealCap: 3 }).exhausted).toBe(true);
    expect(countExhaustedRetries(comments)).toBe(1);
    expect(countExhaustedRetries([...comments, { ...retry, createdAt: '2026-10-14T05:00:00Z' }])).toBe(2);
  });
  it('hands off a new required failure on the recovered head instead of stranding it', () => {
    const pr = green();
    const f = fixture(pr);
    sweepExhaustedRetry(f.options);
    const failure = pr.statusCheckRollup.find(row => row.name === 'daemon-soak');
    failure.conclusion = 'FAILURE';
    failure.completedAt = '2026-10-14T05:00:00Z';
    const ciHealBudget = resolveCiHealBudget({ repo: { resetOnFixHead: true } });
    const plan = planReconcile({ prs: [{ ...pr, state: 'OPEN', mergeStateStatus: 'CLEAN',
      labels: [{ name: 'ci:failed' }], comments: f.comments }], agents: [], ciHealBudget,
      now: Date.parse('2026-10-14T06:00:00Z') });
    expect(plan.notes.some(n => n.kind === 'ci-heal-exhausted')).toBe(true);
    expect(exhaustionFacts({ comments: f.comments, ciHealBudget, headSha: sha }).exhausted).toBe(true);
    expect(sweepExhaustedRetry(f.options).refusals[0]?.kind).toBe('needs-you');
    expect(f.postComment).toHaveBeenCalledTimes(2);
    sweepExhaustedRetry(f.options);
    expect(f.postComment).toHaveBeenCalledTimes(2);
  });
});

// Every durable retry state uses the same authenticated leading-header reader.
describe('retry marker trust across recovery', () => {
  it.each([EXHAUSTED_RETRY_RECOVERED_MARKER, EXHAUSTED_RETRY_SPENT_RESOLVED_MARKER])(
    'rejects forged, anonymous and quoted %s markers', marker => {
      const valid = { ...trusted(marker), createdAt: later };
      const invalid = [
        { ...valid, author: { login: 'outsider' } },
        { body: marker, createdAt: later }, marker,
        { ...valid, body: `quoted\n${marker}` },
        { ...valid, body: `> ${marker}` },
      ];
      expect(trustedRetryMarkerComments(invalid, marker)).toEqual([]);
      expect(trustedRetryMarkerComments([...invalid, valid], marker)).toEqual([valid]);
      for (const comment of invalid) {
        const retry = trusted(buildExhaustedRetryComment({ headSha }));
        expect(exhaustionFacts({ comments: [...heals, retry, comment], ciHealCap: 3 }).exhausted).toBe(true);
        expect(countExhaustedRetries([retry, comment])).toBe(1);
      }
    });

  it('does not let forged recovery suppress publication or quoted resolution hide our spent record', () => {
    const requiredChecks = ['test'];
    const pr = { headRefOid: headSha, statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: later }] };
    const retry = trusted(buildExhaustedRetryComment({ headSha }));
    const recovered = { ...trusted(`${EXHAUSTED_RETRY_RECOVERED_MARKER}\nhead: ${headSha}`), createdAt: later };
    for (const bogus of [{ ...recovered, author: { login: 'outsider' } }, { ...recovered, body: `quoted\n${recovered.body}` }]) {
      const postComment = vi.fn();
      sweepExhaustedRetry({ apply: true, settings: settings(), candidates: [{ prNumber: 1, headSha, pr, requiredChecks,
        comments: [...heals, retry, bogus] }], postComment });
      expect(postComment).toHaveBeenCalledOnce();
      expect(postComment.mock.calls[0][1].body.startsWith(EXHAUSTED_RETRY_RECOVERED_MARKER)).toBe(true);
    }
    const spent = trusted(`${buildExhaustedRetrySpentComment({ headSha })}\nquoted\n${EXHAUSTED_RETRY_SPENT_RESOLVED_MARKER}`);
    expect(wrongSpentStandDowns({ comments: [spent], pr, requiredChecks })).toEqual([spent]);
    const resolved = { ...spent, body: buildResolvedSpentComment(spent, headSha) };
    expect(wrongSpentStandDowns({ comments: [resolved], pr, requiredChecks })).toEqual([]);
  });

  it('keeps waiting for required results after recovery when a new run is incomplete', () => {
    const retry = trusted(buildExhaustedRetryComment({ headSha }));
    const recovered = { ...trusted(EXHAUSTED_RETRY_RECOVERED_MARKER), createdAt: later };
    expect(retryOutcome({ comments: [retry, recovered], pr: { headRefOid: headSha }, requiredChecks: ['test'] })).toEqual({ state: 'pending' });
  });

  it('treats a failed mechanical attempt as terminal even though it launched no CI', () => {
    const retry = trusted(buildExhaustedRetryComment({ headSha, ok: false }));
    expect(retryOutcome({ comments: [retry], pr: { headRefOid: headSha }, requiredChecks: ['test'] }))
      .toMatchObject({ state: 'failed' });
  });
});
