/**
 * @file scripts/conveyor/health-smells/__tests__/pr-stage-stall.test.mjs
 * @description #4066 — seed smell 8, the SYSTEMIC stuck-PR cluster, driven through the slice-1 core
 *   (`runHealthTick`) on fixture PR records shaped like `health-watch.mjs#probePrs`'s output. Proves the ruling's
 *   alert-only leg: an open cluster plans no `investigate` and `planInvestigations` never picks it, even with agent
 *   dispatch switched on — and its recommendation carries the stuck-PR watch's own posted inspections.
 */
import { describe, it, expect } from 'vitest';
import { runHealthTick, emptyHealthState, MINUTE } from '../../health-watch-core.mjs';
import { planInvestigations } from '../../health-investigate-plan.mjs';
import { STUCK_DISPATCH_MARKER } from '../../stuck-pr-dispatch-marker.mjs';
import { STAND_DOWN_MARKER } from '../../stand-down.mjs';
import smell, { workingSession, stuckWatchRecord } from '../pr-stage-stall.mjs';

const NOW = Date.parse('2026-09-29T12:00:00Z');
const REPO = 'web-everything/web-everything';
const ago = (m) => new Date(NOW - m * MINUTE).toISOString();

function pr(number, { labels = ['review:pending'], minutes = 90, mergeable = 'MERGEABLE', comments = [], isDraft = false } = {}) {
  return { repo: REPO, number, title: `PR ${number}`, updatedAt: ago(minutes), isDraft, mergeable, labels: labels.map((name) => ({ name })), comments };
}

const marker = (activityAt) => ({ body: `${STUCK_DISPATCH_MARKER}\n\nepisode: ${activityAt}\n\nNo progress…`, createdAt: ago(60), author: { login: 'we-conveyor[bot]' } });
const diagnosis = (text) => ({ body: `🔎 stuck-PR inspection — findings\n\n${text}`, createdAt: ago(40), author: { login: 'we-conveyor[bot]' } });

/** Run consecutive gh-cadence samples (15 min apart) through the real core. */
function ticks(prsPerTick, { agents = [] } = {}) {
  let state = emptyHealthState();
  let last;
  prsPerTick.forEach((prs, i) => {
    last = runHealthTick(state, { prs, agents }, [smell], NOW + i * 15 * MINUTE);
    state = last.state;
  });
  return last;
}

describe('pr-stage-stall — helpers', () => {
  it('workingSession matches a live <role>-<pr> session and never a finished one or a different PR', () => {
    expect(workingSession([{ name: 'review-2901', state: 'working' }], 2901)?.name).toBe('review-2901');
    expect(workingSession([{ name: 'fix-we-2901-r2', state: 'working' }], 2901)?.name).toBe('fix-we-2901-r2');
    expect(workingSession([{ name: 'review-2901', state: 'done' }], 2901)).toBeNull();
    expect(workingSession([{ name: 'review-29011', state: 'working' }], 2901)).toBeNull();
    // the stuck-PR watch's own inspector is not "working" the PR — the PR is still stuck while it is inspected
    expect(workingSession([{ name: 'inspect-2901', state: 'working' }], 2901)).toBeNull();
  });

  it('stuckWatchRecord counts the watch markers and extracts the inspector findings, not the marker text', () => {
    const r = stuckWatchRecord([marker(ago(120)), diagnosis('The review daemon refused no-lane for 2h.'), { body: 'a human comment' }]);
    expect(r.dispatchedEpisodes).toBe(1);
    expect(r.diagnoses).toHaveLength(1);
    expect(r.diagnoses[0].excerpt).toBe('The review daemon refused no-lane for 2h.');
  });
});

describe('pr-stage-stall — through the slice-1 core', () => {
  const three = () => [pr(1), pr(2, { comments: [marker(ago(120)), diagnosis('review-daemon lane starvation')] }), pr(3)];

  it('3 PRs stuck in `review` open ONE repo:stage episode after two gh samples', () => {
    const first = ticks([three()]);
    expect(first.transitions).toEqual([]);
    const second = ticks([three(), three()]);
    expect(second.transitions.map((t) => [t.type, t.key])).toEqual([['opened', `pr-stage-stall::${REPO}:review`]]);
    const ep = second.state.episodes[`pr-stage-stall::${REPO}:review`];
    expect(ep.measure).toMatchObject({ stage: 'review', stuck: 3, inspected: 1 });
    // the recommendation aggregates what the stuck-PR watch already posted
    expect(ep.recommendation).toContain('#2: review-daemon lane starvation');
    expect(ep.recommendation).toContain('No new agent is dispatched');
  });

  it('is ALERT-ONLY: no investigate plan, and planInvestigations never dispatches it even with dispatch ON', () => {
    const r = ticks([three(), three()]);
    expect(r.plan.filter((p) => p.kind === 'investigate')).toEqual([]);
    const inv = planInvestigations({
      episodes: r.state.episodes, smellsById: { [smell.id]: smell }, ledger: [], config: { investigateDispatch: true }, now: NOW,
    });
    expect(inv.off).toBe(false);
    expect(inv.dispatch).toEqual([]);
    expect(inv.held).toEqual([]); // not even a candidate
  });

  it('2 stuck PRs are below the cluster — reported, never opened', () => {
    const r = ticks([[pr(1), pr(2)], [pr(1), pr(2)]]);
    expect(r.transitions).toEqual([]);
    expect(r.evaluations[0].results[0]).toMatchObject({ breach: false, measure: { stuck: 2 } });
  });

  it('does not count a PR inside its stage threshold, a live-worked PR, a draft, a stood-down PR, or review:human', () => {
    const standDown = { body: `${STAND_DOWN_MARKER}\n\nconveyor fix agent stopped rather than guessing: x.`, author: { login: 'chalbert' } };
    const prs = [
      pr(1), pr(2), // stuck
      pr(3, { minutes: 20 }), // review threshold is 45m
      pr(4), // worked by a live session
      pr(5, { isDraft: true }),
      pr(6, { comments: [standDown] }),
      pr(7, { labels: ['review:human'] }),
    ];
    const r = ticks([prs, prs], { agents: [{ name: 'review-4', state: 'working' }] });
    expect(r.transitions).toEqual([]);
    expect(r.evaluations[0].results[0].measure.prs.map((p) => p.number)).toEqual([1, 2]);
  });

  it('clusters per stage: 3 in `approved` (accepted + mergeable, past 30m) is its own subject', () => {
    const approved = [1, 2, 3].map((n) => pr(n, { labels: ['review:accepted'], minutes: 35 }));
    const r = ticks([approved, approved]);
    expect(r.transitions.map((t) => t.key)).toEqual([`pr-stage-stall::${REPO}:approved`]);
  });

  it('closes once the cluster clears (two clean samples)', () => {
    const r = ticks([three(), three(), [pr(1)], []]);
    expect(r.transitions.map((t) => t.type)).toEqual(['closed']);
  });
});
