import { describe, expect, it, vi } from 'vitest';
import { createRedTeamFeed, planRedTeamFeed } from '../red-team-feed.mjs';
import { buildReviewedShaMarker } from '../review-escalation.mjs';
import { scenario } from '../../conveyor/soak/breaks/redteam-feed-pending-never-queued.mjs';

const head = 'a'.repeat(40), repo = 'web-everything/web-everything';
const finished = { author: { login: 'web-everything' }, body: buildReviewedShaMarker(head), createdAt: '2026-11-24T10:00:00Z' };
const pr = (over = {}) => ({ number: 7, headRefOid: head, state: 'OPEN', isDraft: false,
  labels: ['red-team:pending'], comments: [finished], updatedAt: '2026-11-24T10:00:00Z', ...over });
const gate = { author: { login: 'web-everything' }, createdAt: '2026-11-24T10:05:00Z',
  body: `<!-- we:red-team-advisory pr=7 rev=${head} -->\nno findings` };
const NOW = Date.parse('2026-11-24T12:00:00Z');

describe('red-team feed', () => {
  it('does not enqueue a PR with a live review (no finished record, process live)', () => {
    const rows = planRedTeamFeed({ plan: {}, rawPrs: [pr({ comments: [] })], now: NOW, hasLiveProcess: () => true });
    expect(rows).toEqual([]);
  });
  it('does not enqueue a quiet unfinished review without a process reader', () => {
    expect(planRedTeamFeed({ plan: {}, rawPrs: [pr({ comments: [] })], now: NOW })).toEqual([]);
  });
  it('does not enqueue a head that already has a red-team gate comment', () => {
    expect(planRedTeamFeed({ plan: {}, rawPrs: [pr({ comments: [finished, gate] })], now: NOW })).toEqual([]);
  });
  it.each(['review:held-mechanical', 'hold:fix'])('does not enqueue a PR labelled %s', label => {
    expect(planRedTeamFeed({ plan: {}, rawPrs: [pr({ labels: ['red-team:pending', label] })], now: NOW })).toEqual([]);
  });
  it('does not enqueue a fix-claimed, draft, or not-pending PR', () => {
    for (const over of [{ fixClaim: { who: 'x' } }, { isDraft: true }, { labels: [] }]) {
      expect(planRedTeamFeed({ plan: {}, rawPrs: [pr(over)], now: NOW })).toEqual([]);
    }
  });
  it('does not duplicate an existing queue nomination', () => {
    const plan = { refusals: [{ kind: 'already-reviewed-head', prNumber: 7, headSha: head }] };
    expect(planRedTeamFeed({ plan, rawPrs: [pr()], now: NOW })).toEqual([]);
  });
  it('enqueues a pending PR with a finished review and no gate comment (reason a)', () => {
    expect(planRedTeamFeed({ plan: {}, rawPrs: [pr()], now: NOW })).toEqual([{ prNumber: 7, headSha: head, reason: 'a' }]);
  });
  it('enqueues a finished review that reconciliation refused as nothing-owed', () => {
    const plan = { refusals: [{ kind: 'nothing-owed', phase: 'open', prNumber: 7, headRefOid: head }] };
    expect(planRedTeamFeed({ plan, rawPrs: [pr()], now: NOW })).toEqual([{ prNumber: 7, headSha: head, reason: 'a' }]);
  });
  it.each(['live-process', 'owed-elsewhere', 'held-mechanical', 'unknown-refusal'])('does not bypass a %s refusal', kind => {
    const plan = { refusals: [{ kind, prNumber: 7 }] };
    expect(planRedTeamFeed({ plan, rawPrs: [pr()], now: NOW })).toEqual([]);
  });
  it.each(['review', 'fix', 'ci-heal'])('does not bypass a planned %s dispatch alongside nothing-owed', kind => {
    const plan = { refusals: [{ kind: 'nothing-owed', prNumber: 7 }], dispatch: [{ kind, prNumber: 7 }] };
    expect(planRedTeamFeed({ plan, rawPrs: [pr()], now: NOW })).toEqual([]);
  });
  it('preserves nothing-owed and appends only one queue nomination when fed again', () => {
    const feed = createRedTeamFeed({ now: () => NOW });
    const refusal = { kind: 'nothing-owed', phase: 'open', prNumber: 7, headRefOid: head };
    const plan = { refusals: [refusal] };
    const fed = feed({ repo, plan, rawPrs: [pr()] });
    expect(fed.refusals).toEqual([refusal, { kind: 'already-reviewed-head', prNumber: 7, headSha: head }]);
    expect(plan.refusals).toEqual([refusal]);
    expect(feed({ repo, plan: fed, rawPrs: [pr()] })).toBe(fed);
  });
  it('admits the real reconciliation refusal through the daemon recovery adaptation and queue', async () => {
    expect(await scenario()).toEqual([]);
  });
  it('enqueues a quiet unfinished review with no live process (reason c)', () => {
    const rows = planRedTeamFeed({ plan: {}, rawPrs: [pr({ comments: [] })], now: NOW, hasLiveProcess: () => false });
    expect(rows).toEqual([{ prNumber: 7, headSha: head, reason: 'c' }]);
  });
  it('enqueues the same head only once in the log, and appends one refusal per tick', () => {
    const log = vi.fn(), feed = createRedTeamFeed({ log, now: () => NOW });
    const first = feed({ repo, plan: { refusals: [] }, rawPrs: [pr()] });
    feed({ repo, plan: { refusals: [] }, rawPrs: [pr()] });
    expect(first.refusals).toEqual([{ kind: 'already-reviewed-head', prNumber: 7, headSha: head }]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(`review-daemon: red-team enqueue (feed) ${repo}#7 reason=a`);
  });
  it('feeds nothing on an incomplete inventory', () => {
    const plan = { refusals: [] };
    expect(createRedTeamFeed({ now: () => NOW })({ repo, plan, rawPrs: [pr()], inventoryComplete: false })).toBe(plan);
  });
});
