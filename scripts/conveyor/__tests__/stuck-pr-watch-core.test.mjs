/**
 * @file scripts/conveyor/__tests__/stuck-pr-watch-core.test.mjs
 * @description Pins the stuck-PR watch's pure core (epic #3383): the four per-stage thresholds (and their env
 *   overrides), the three never-stuck exclusions, the live-agent reuse (never re-derived), the per-episode
 *   dispatch idempotency, and the concurrency cap.
 */
import { describe, it, expect } from 'vitest';
import { loadFlakeLegacyBody } from './load-flake-fixture.mjs';
import { buildOperatorAnswer } from '../stand-down-answer-core.mjs';
import {
  STUCK_STAGES, DEFAULT_STUCK_THRESHOLD_MINUTES, STUCK_THRESHOLD_ENV, stuckThresholdMinutes,
  isDraftPr, isNeverStuckPr, classifyStuckStage, PROGRESS_TIMELINE_EVENTS, latestActivityAt,
  minutesSinceActivity, evaluateStuckPr, STUCK_DISPATCH_MARKER, buildStuckDispatchComment,
  stuckDispatchEpisodes, alreadyDispatchedForEpisode, DEFAULT_MAX_CONCURRENT_INSPECTIONS,
  MAX_CONCURRENT_INSPECTIONS_ENV, maxConcurrentInspections, planStuckDispatches, isStuckInspectionOwnComment,
  buildStuckDispatchRetractionComment, stuckDispatchRetractions,
} from '../stuck-pr-watch-core.mjs';
import { buildStandDownComment, buildLoadFlakeHoldComment, buildLoadFlakeResolvedComment } from '../stand-down.mjs';

describe('dispatch retraction (PR #2553 review — marker first, then launch)', () => {
  const T = '2026-09-23T17:00:00Z';
  const marker = { body: buildStuckDispatchComment({ stage: 'fix', minutesSince: 90, thresholdMinutes: 45, activityAt: T, sessionSlug: 'inspect-42' }) };
  const retraction = { body: buildStuckDispatchRetractionComment({ activityAt: T }) };
  it('a retraction after the marker reopens the episode; a later marker (the retry) closes it again', () => {
    expect(alreadyDispatchedForEpisode([marker, retraction], T)).toBe(false);
    expect(alreadyDispatchedForEpisode([marker, retraction, marker], T)).toBe(true);
    expect(stuckDispatchEpisodes([marker, retraction])).toEqual([]);
  });
  it('orders by createdAt when every comment has one, not by the order given', () => {
    const at = (c, createdAt) => ({ ...c, createdAt });
    expect(alreadyDispatchedForEpisode([
      at(marker, '2026-09-23T19:30:00Z'), at(retraction, '2026-09-23T19:05:00Z'), at(marker, '2026-09-23T19:00:00Z'),
    ], T)).toBe(true);
  });
  it('a retraction only cancels its OWN episode, and is counted per episode', () => {
    const other = { body: buildStuckDispatchRetractionComment({ activityAt: '2026-09-01T00:00:00Z' }) };
    expect(alreadyDispatchedForEpisode([marker, other], T)).toBe(true);
    expect(stuckDispatchRetractions([marker, other, retraction], T)).toBe(1);
    expect(stuckDispatchRetractions([marker, other], T)).toBe(0);
  });
  it('is one of the feature\'s own comments, so it never counts as progress', () => {
    expect(isStuckInspectionOwnComment(retraction.body)).toBe(true);
    expect(latestActivityAt([
      { createdAt: T, event: 'commented', body: 'human' },
      { createdAt: '2026-09-23T18:00:00Z', event: 'commented', body: retraction.body },
    ])).toBe(T);
  });
});

const HUMAN = { name: 'review:human' };
const PENDING = { name: 'review:pending' };
const CHANGES = { name: 'review:changes' };
const ACCEPTED = { name: 'review:accepted' };
const READY = { name: 'ready-to-merge' };
const REVIEWING = { name: 'review-status:reviewing' };

describe('stuckThresholdMinutes', () => {
  it('defaults to the operator-agreed thresholds (45/45/30/45)', () => {
    expect(stuckThresholdMinutes({})).toEqual(DEFAULT_STUCK_THRESHOLD_MINUTES);
    expect(DEFAULT_STUCK_THRESHOLD_MINUTES).toEqual({
      [STUCK_STAGES.REVIEW]: 45, [STUCK_STAGES.FIX]: 45, [STUCK_STAGES.APPROVED]: 30, [STUCK_STAGES.CONFLICT]: 45,
    });
  });

  it('each stage is overridable by its own env var', () => {
    const env = {
      [STUCK_THRESHOLD_ENV[STUCK_STAGES.REVIEW]]: '10',
      [STUCK_THRESHOLD_ENV[STUCK_STAGES.APPROVED]]: '5',
    };
    const t = stuckThresholdMinutes(env);
    expect(t[STUCK_STAGES.REVIEW]).toBe(10);
    expect(t[STUCK_STAGES.APPROVED]).toBe(5);
    expect(t[STUCK_STAGES.FIX]).toBe(45); // unset stages keep the default
    expect(t[STUCK_STAGES.CONFLICT]).toBe(45);
  });

  it('a bad override fails LOUD, never silently falls back', () => {
    expect(() => stuckThresholdMinutes({ [STUCK_THRESHOLD_ENV[STUCK_STAGES.FIX]]: '0' })).toThrow(/positive number of minutes/);
    expect(() => stuckThresholdMinutes({ [STUCK_THRESHOLD_ENV[STUCK_STAGES.FIX]]: '-5' })).toThrow(/positive number of minutes/);
    expect(() => stuckThresholdMinutes({ [STUCK_THRESHOLD_ENV[STUCK_STAGES.FIX]]: 'soon' })).toThrow(/positive number of minutes/);
  });
});

describe('isNeverStuckPr — the three exclusions', () => {
  it('review:human is never stuck', () => {
    expect(isNeverStuckPr({ labels: [HUMAN, PENDING] })).toBe(true);
  });
  it('a draft is never stuck', () => {
    expect(isDraftPr({ isDraft: true })).toBe(true);
    expect(isNeverStuckPr({ labels: [PENDING], isDraft: true })).toBe(true);
  });
  it('a stood-down PR is never stuck', () => {
    // #3383 — a trusted author is now required for the stand-down marker to count.
    const comments = [{ body: buildStandDownComment({ reason: 'gate-red' }), author: { login: 'web-everything' } }];
    expect(isNeverStuckPr({ labels: [CHANGES], comments })).toBe(true);
  });
  it('an ordinary PR is not excluded', () => {
    expect(isNeverStuckPr({ labels: [PENDING], isDraft: false, comments: [] })).toBe(false);
  });
});

describe('classifyStuckStage', () => {
  it('conflict wins even over an approved label — WE #2505\'s own shape', () => {
    expect(classifyStuckStage({ labels: [ACCEPTED], mergeable: 'CONFLICTING' })).toBe(STUCK_STAGES.CONFLICT);
  });
  it('review:changes → fix', () => {
    expect(classifyStuckStage({ labels: [CHANGES], mergeable: 'MERGEABLE' })).toBe(STUCK_STAGES.FIX);
  });
  it('review:pending → review', () => {
    expect(classifyStuckStage({ labels: [PENDING], mergeable: 'MERGEABLE' })).toBe(STUCK_STAGES.REVIEW);
  });
  it('review-status:reviewing alone (no review:pending) still → review', () => {
    expect(classifyStuckStage({ labels: [REVIEWING], mergeable: 'MERGEABLE' })).toBe(STUCK_STAGES.REVIEW);
  });
  it('review:accepted + MERGEABLE → approved', () => {
    expect(classifyStuckStage({ labels: [ACCEPTED], mergeable: 'MERGEABLE' })).toBe(STUCK_STAGES.APPROVED);
  });
  it('ready-to-merge + MERGEABLE → approved too (either label)', () => {
    expect(classifyStuckStage({ labels: [READY], mergeable: 'MERGEABLE' })).toBe(STUCK_STAGES.APPROVED);
  });
  it('review:accepted but mergeable UNKNOWN → no tracked stage (never guessed)', () => {
    expect(classifyStuckStage({ labels: [ACCEPTED], mergeable: 'UNKNOWN' })).toBeNull();
  });
  it('no review label at all, not conflicting → no tracked stage', () => {
    expect(classifyStuckStage({ labels: [], mergeable: 'MERGEABLE' })).toBeNull();
  });
});

describe('latestActivityAt', () => {
  it('picks the most recent of labeled/commented/committed, ignoring other event types', () => {
    const events = [
      { createdAt: '2026-09-20T10:00:00Z', event: 'labeled' },
      { createdAt: '2026-09-22T10:00:00Z', event: 'reviewed' }, // NOT a tracked progress type
      { createdAt: '2026-09-21T10:00:00Z', event: 'commented' },
    ];
    expect(latestActivityAt(events)).toBe('2026-09-21T10:00:00Z');
  });
  it('never counts the watch\'s own marker or the inspection agent\'s diagnosis as progress (PR #2553 review)', () => {
    const marker = buildStuckDispatchComment({
      stage: 'fix', minutesSince: 120, thresholdMinutes: 45, activityAt: '2026-09-20T10:00:00Z', sessionSlug: 'inspect-1',
    });
    const events = [
      { createdAt: '2026-09-20T10:00:00Z', event: 'commented', body: 'real progress' },
      { createdAt: '2026-09-20T12:00:00Z', event: 'commented', body: marker },
      { createdAt: '2026-09-20T12:10:00Z', event: 'commented', body: '\n🔎 stuck-PR inspection\n\nfindings…' },
    ];
    expect(latestActivityAt(events)).toBe('2026-09-20T10:00:00Z');
    // A human QUOTING the marker mid-reply is still a real comment — still progress.
    expect(latestActivityAt([...events, {
      createdAt: '2026-09-20T13:00:00Z', event: 'commented', body: `why did ${STUCK_DISPATCH_MARKER} fire?`,
    }])).toBe('2026-09-20T13:00:00Z');
    // A body-less comment event (no body read) keeps counting — fail toward "progress", never toward a re-dispatch.
    expect(latestActivityAt([{ createdAt: '2026-09-20T14:00:00Z', event: 'commented' }])).toBe('2026-09-20T14:00:00Z');
    expect(isStuckInspectionOwnComment(marker)).toBe(true);
    expect(isStuckInspectionOwnComment(null)).toBe(false);
  });
  it('returns null for no events, or none of the tracked types', () => {
    expect(latestActivityAt([])).toBeNull();
    expect(latestActivityAt([{ createdAt: '2026-09-20T10:00:00Z', event: 'assigned' }])).toBeNull();
    expect(latestActivityAt(null)).toBeNull();
  });
  it('every declared progress type is exactly the task\'s own three', () => {
    expect(PROGRESS_TIMELINE_EVENTS).toEqual(['labeled', 'commented', 'committed']);
  });
});

describe('minutesSinceActivity', () => {
  it('computes elapsed minutes', () => {
    expect(minutesSinceActivity('2026-09-23T18:00:00Z', new Date('2026-09-23T19:00:00Z').getTime())).toBe(60);
  });
  it('null for unparseable/absent input, never negative/NaN', () => {
    expect(minutesSinceActivity(null)).toBeNull();
    expect(minutesSinceActivity('not-a-date')).toBeNull();
    expect(minutesSinceActivity('2026-09-23T19:00:00Z', new Date('2026-09-23T18:00:00Z').getTime())).toBeNull();
  });
});

describe('evaluateStuckPr — the whole decision', () => {
  const now = new Date('2026-09-23T19:00:00Z').getTime();

  it('excluded PRs never reach a stage check', () => {
    expect(evaluateStuckPr({ pr: { labels: [HUMAN, PENDING] }, now })).toEqual({ stuck: false, reason: 'excluded' });
  });

  it('no tracked stage → not stuck, stage:null', () => {
    expect(evaluateStuckPr({ pr: { labels: [] }, now })).toEqual({ stuck: false, reason: 'no-tracked-stage', stage: null });
  });

  it('no activity evidence at all → fails closed, never stuck', () => {
    const pr = { labels: [PENDING] };
    expect(evaluateStuckPr({ pr, now, activityAt: null })).toEqual({ stuck: false, reason: 'no-activity-evidence', stage: 'review', activityAt: null });
  });

  it('within threshold → not stuck', () => {
    const pr = { labels: [PENDING] };
    const activityAt = '2026-09-23T18:30:00Z'; // 30 minutes ago, under the 45m review threshold
    const v = evaluateStuckPr({ pr, now, activityAt });
    expect(v.stuck).toBe(false);
    expect(v.reason).toBe('within-threshold');
    expect(v.minutesSince).toBe(30);
    expect(v.thresholdMinutes).toBe(45);
  });

  it('past threshold with a live bound agent → not stuck (reuses assessLiveness/bindAgents, never re-derived)', () => {
    const pr = { number: 2505, labels: [PENDING], headRefOid: 'deadbeef' };
    const activityAt = '2026-09-23T18:00:00Z'; // 60 minutes ago, over the 45m threshold
    const agents = [{ name: 'review-2505', pid: 111, pidAlive: true, cwd: '/lane' }];
    const v = evaluateStuckPr({ pr, agents, repo: 'we', now, activityAt });
    expect(v.stuck).toBe(false);
    expect(v.reason).toBe('live-agent');
    expect(v.live.kind).toBe('live-process');
  });

  it('past threshold, nothing live → STUCK', () => {
    const pr = { number: 2505, labels: [PENDING], headRefOid: 'deadbeef' };
    const activityAt = '2026-09-23T18:00:00Z'; // 60 minutes ago
    const v = evaluateStuckPr({ pr, agents: [], repo: 'we', now, activityAt });
    expect(v).toEqual({
      stuck: true, reason: 'stuck', stage: 'review', minutesSince: 60, thresholdMinutes: 45, activityAt,
    });
  });

  it('the approved stage uses its own tighter 30m threshold', () => {
    const pr = { labels: [ACCEPTED], mergeable: 'MERGEABLE' };
    const activityAt = '2026-09-23T18:29:00Z'; // 31 minutes ago — over 30m approved, under 45m review/fix
    const v = evaluateStuckPr({ pr, now, activityAt });
    expect(v.stuck).toBe(true);
    expect(v.stage).toBe('approved');
    expect(v.thresholdMinutes).toBe(30);
  });

  it('custom thresholds are honoured', () => {
    const pr = { labels: [PENDING] };
    const activityAt = '2026-09-23T18:59:00Z'; // 1 minute ago
    const v = evaluateStuckPr({ pr, now, activityAt, thresholds: { review: 1, fix: 45, approved: 30, conflict: 45 } });
    expect(v.stuck).toBe(true);
  });
});

describe('dispatch-marker idempotency (episode keyed on the exact activityAt)', () => {
  it('the marker is its own distinct constant, never confused with the inspecting agent\'s own comment', () => {
    expect(STUCK_DISPATCH_MARKER).toBe('🔎 stuck-PR inspection dispatched');
  });

  it('buildStuckDispatchComment embeds the episode verbatim and opens with the marker', () => {
    const body = buildStuckDispatchComment({
      stage: 'conflict', minutesSince: 390.4, thresholdMinutes: 45, activityAt: '2026-09-23T12:27:00Z', sessionSlug: 'inspect-2505',
    });
    expect(body.startsWith(STUCK_DISPATCH_MARKER)).toBe(true);
    expect(body).toContain('episode: 2026-09-23T12:27:00Z');
    expect(body).toContain('inspect-2505');
  });

  it('stuckDispatchEpisodes recovers every embedded episode, ignoring a quoted (non-leading) marker', () => {
    const real = buildStuckDispatchComment({ stage: 'fix', minutesSince: 50, thresholdMinutes: 45, activityAt: 'T1', sessionSlug: 'inspect-9' });
    const quoted = { body: `> ${STUCK_DISPATCH_MARKER}\n\nepisode: T-FAKE` };
    expect(stuckDispatchEpisodes([{ body: real }, quoted])).toEqual(['T1']);
  });

  it('alreadyDispatchedForEpisode matches only the EXACT same episode timestamp', () => {
    const real = buildStuckDispatchComment({ stage: 'fix', minutesSince: 50, thresholdMinutes: 45, activityAt: 'T1', sessionSlug: 'inspect-9' });
    const comments = [{ body: real }];
    expect(alreadyDispatchedForEpisode(comments, 'T1')).toBe(true);
    expect(alreadyDispatchedForEpisode(comments, 'T2')).toBe(false); // fresh activity since → a NEW episode, dispatch again
    expect(alreadyDispatchedForEpisode(comments, null)).toBe(false);
    expect(alreadyDispatchedForEpisode([], 'T1')).toBe(false);
  });
});

describe('concurrency cap', () => {
  it('defaults to 2, overridable by env, refuses a bad override', () => {
    expect(maxConcurrentInspections({})).toBe(DEFAULT_MAX_CONCURRENT_INSPECTIONS);
    expect(DEFAULT_MAX_CONCURRENT_INSPECTIONS).toBe(2);
    expect(maxConcurrentInspections({ [MAX_CONCURRENT_INSPECTIONS_ENV]: '5' })).toBe(5);
    expect(() => maxConcurrentInspections({ [MAX_CONCURRENT_INSPECTIONS_ENV]: '0' })).toThrow(/positive integer/);
    expect(() => maxConcurrentInspections({ [MAX_CONCURRENT_INSPECTIONS_ENV]: '1.5' })).toThrow(/positive integer/);
  });

  it('dispatches up to the remaining capacity, longest-overdue first, and defers the rest', () => {
    const candidates = [
      { num: 1, minutesSince: 50, thresholdMinutes: 45 },   // 5 over
      { num: 2, minutesSince: 100, thresholdMinutes: 45 },  // 55 over — most overdue
      { num: 3, minutesSince: 60, thresholdMinutes: 30 },   // 30 over
    ];
    const { toDispatch, deferred } = planStuckDispatches({ candidates, liveInspectCount: 0, maxConcurrent: 2 });
    expect(toDispatch.map((c) => c.num)).toEqual([2, 3]);
    expect(deferred.map((c) => c.num)).toEqual([1]);
    expect(deferred[0].deferredReason).toBe('concurrency-cap');
  });

  it('live sessions already count against the cap', () => {
    const candidates = [{ num: 1, minutesSince: 50, thresholdMinutes: 45 }, { num: 2, minutesSince: 60, thresholdMinutes: 45 }];
    const { toDispatch, deferred } = planStuckDispatches({ candidates, liveInspectCount: 2, maxConcurrent: 2 });
    expect(toDispatch).toEqual([]);
    expect(deferred.length).toBe(2);
  });

  it('a liveInspectCount above the cap never goes negative-capacity', () => {
    const candidates = [{ num: 1, minutesSince: 50, thresholdMinutes: 45 }];
    const { toDispatch } = planStuckDispatches({ candidates, liveInspectCount: 99, maxConcurrent: 2 });
    expect(toDispatch).toEqual([]);
  });
});


describe('load-flake hold exclusions', () => {
  const comment = (body, createdAt = '2026-10-04T18:00:00Z') => ({ body, createdAt, author: { login: 'web-everything' } });
  it('excludes a live hold until pushed or the recorded head moves', () => {
    const hold = comment(buildLoadFlakeHoldComment({ head: 'aaa1111', alt: 'lane/fix-alt', altSha: 'bbb2222' }));
    const pr = { headRefOid: 'aaa1111', comments: [hold] };
    expect(isNeverStuckPr(pr)).toBe(true);
    expect(isNeverStuckPr({ ...pr, headRefOid: 'ccc3333' })).toBe(false);
    expect(isNeverStuckPr({ ...pr, comments: [hold, comment(buildLoadFlakeResolvedComment({ altSha: 'bbb2222', result: 'pushed' }), '2026-10-04T19:00:00Z')] })).toBe(false);
  });
  it('excludes a legacy hold only until an operator answer supersedes it', () => {
    const hold = { ...comment(loadFlakeLegacyBody), id: 'IC_legacy_hold' };
    expect(isNeverStuckPr({ comments: [hold] })).toBe(true);
    const answer = comment(buildOperatorAnswer({ standDownId: hold.id, reason: 'handled', actor: 'chalbert', channel: 'test' }), '2026-10-04T19:00:00Z');
    expect(isNeverStuckPr({ comments: [hold, answer] })).toBe(false);
  });
});
