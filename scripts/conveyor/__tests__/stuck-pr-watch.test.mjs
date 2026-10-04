/**
 * @file scripts/conveyor/__tests__/stuck-pr-watch.test.mjs
 * @description The stuck-PR watch's IO shell (epic #3383): the discovery argv, the lazy per-candidate timeline
 *   fetch, and — the property the PROOF requirement most cares about — that `--dry-run` NEVER calls the
 *   dispatcher or the comment provider, while a real sweep dispatches + comments on exactly the PRs the
 *   concurrency cap allows.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  defaultListOpenPrs, defaultListTimelineEvents, defaultCountLiveInspections, watchStuckPrs, PR_LIST_JSON_FIELDS,
  defaultReadFullTimeline,
} from '../stuck-pr-watch.mjs';
import { STUCK_DISPATCH_MARKER, STUCK_DISPATCH_RETRACTED_MARKER } from '../stuck-pr-watch-core.mjs';
import { markNoInspectionStarted } from '../stuck-pr-inspect-dispatch.mjs';

const PENDING = { name: 'review:pending' };
const CHANGES = { name: 'review:changes' };

/** A minimal open PR fixture in the `fix` stage, stuck (no activity for 2h, threshold 45m). */
function stuckFixPr(overrides = {}) {
  return {
    number: 42, headRefName: 'lane/42-x', headRefOid: 'deadbeef', labels: [CHANGES], mergeable: 'MERGEABLE',
    isDraft: false, comments: [], ...overrides,
  };
}

describe('defaultListOpenPrs', () => {
  it('asks for every field the pure core needs, in one call', () => {
    const exec = vi.fn(() => '[]');
    defaultListOpenPrs({ exec, repo: 'web-everything/web-everything' });
    expect(exec).toHaveBeenCalledWith('gh', [
      'pr', 'list', '--state', 'open', '--limit', '200', '--json', PR_LIST_JSON_FIELDS,
      '--repo', 'web-everything/web-everything',
    ], expect.any(Object));
  });
  it('omits --repo when none is given', () => {
    const exec = vi.fn(() => '[]');
    defaultListOpenPrs({ exec });
    expect(exec.mock.calls[0][1]).not.toContain('--repo');
  });
});

describe('defaultListTimelineEvents', () => {
  it('queries the paginated issues timeline, projecting only the three progress event types', () => {
    const exec = vi.fn(() => [
      JSON.stringify({ createdAt: 'T1', event: 'labeled', body: null }),
      JSON.stringify({ createdAt: 'T2', event: 'commented', body: 'line one\n\tline two' }),
      '',
    ].join('\n'));
    const events = defaultListTimelineEvents({ number: 42, repo: 'web-everything/web-everything', exec });
    expect(exec.mock.calls[0][0]).toBe('gh');
    const argv = exec.mock.calls[0][1];
    expect(argv).toContain('repos/web-everything/web-everything/issues/42/timeline');
    expect(argv.join(' ')).toContain('labeled');
    expect(argv.join(' ')).toContain('commented');
    expect(argv.join(' ')).toContain('committed');
    expect(argv.join(' ')).toContain('@json'); // one JSON object per line — a comment body may hold tabs/newlines
    expect(events).toEqual([
      { createdAt: 'T1', event: 'labeled' },
      { createdAt: 'T2', event: 'commented', body: 'line one\n\tline two' },
    ]);
  });
});

describe('defaultReadFullTimeline — the inspection agent\'s GET-only replacement for raw `gh api` (PR #2553 review)', () => {
  it('always issues a fixed -X GET against the PR timeline and parses one JSON object per line', () => {
    const exec = vi.fn(() => `${JSON.stringify({ event: 'labeled', createdAt: 'T1', actor: 'a', label: 'review:changes', body: null })}\n`);
    const events = defaultReadFullTimeline({ number: '42', repo: 'web-everything/web-everything', exec });
    const argv = exec.mock.calls[0][1];
    expect(argv.slice(0, 7)).toEqual(['api', '--paginate', '-X', 'GET', '-F', 'per_page=100',
      'repos/web-everything/web-everything/issues/42/timeline']);
    expect(argv).not.toContain('-f');
    expect(argv).not.toContain('--input');
    expect(events).toEqual([{ event: 'labeled', createdAt: 'T1', actor: 'a', label: 'review:changes', body: null }]);
  });
  it('refuses a non-integer PR or a non-constellation repo before ever calling gh', () => {
    const exec = vi.fn();
    expect(() => defaultReadFullTimeline({ number: '42/../../x', repo: 'web-everything/web-everything', exec })).toThrow(/--pr/);
    expect(() => defaultReadFullTimeline({ number: 42, repo: 'evil/repo', exec })).toThrow(/constellation/);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('defaultCountLiveInspections', () => {
  it('counts only inspect-* sessions, degrading to 0 on a read failure', () => {
    const listAgents = () => [{ name: 'inspect-1' }, { name: 'inspect-pa-2' }, { name: 'review-9' }, { name: 'fix-3' }];
    expect(defaultCountLiveInspections({ listAgents })).toBe(2);
    expect(defaultCountLiveInspections({ listAgents: () => { throw new Error('nope'); } })).toBe(0);
  });
});

describe('watchStuckPrs — the whole sweep, every IO point injected', () => {
  const now = new Date('2026-09-23T19:00:00Z').getTime();
  const oldActivity = () => [{ createdAt: '2026-09-23T17:00:00Z', event: 'commented' }]; // 2h ago > 45m threshold

  it('--dry-run NEVER calls the dispatcher or the comment provider (the PROOF requirement)', () => {
    const dispatch = vi.fn();
    const provider = { postComment: vi.fn(), currentRepo: vi.fn(() => 'web-everything/web-everything') };
    const result = watchStuckPrs({
      repo: 'web-everything/web-everything', dryRun: true, now,
      listPrs: () => [stuckFixPr()],
      listTimelineEvents: oldActivity,
      readAgents: () => [], enrich: (a) => a,
      countLiveInspections: () => 0,
      dispatch, provider,
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(provider.postComment).not.toHaveBeenCalled();
    expect(provider.currentRepo).not.toHaveBeenCalled();
    expect(result.stuck).toBe(1);
    const row = result.results.find((r) => r.num === 42);
    expect(row.verdict).toBe('stuck');
    expect(row.wouldDispatch).toBe(true);
  });

  it('a real sweep dispatches and posts the marker comment for a genuinely stuck PR', () => {
    const dispatch = vi.fn(() => ({ sessionSlug: 'fix-42-inspect', agentId: 'abc123' })); // return shape only — slug not asserted here
    const postComment = vi.fn();
    const provider = { postComment, currentRepo: vi.fn(() => 'web-everything/web-everything') };
    const result = watchStuckPrs({
      repo: 'web-everything/web-everything', dryRun: false, now,
      listPrs: () => [stuckFixPr()],
      listTimelineEvents: oldActivity,
      readAgents: () => [], enrich: (a) => a,
      countLiveInspections: () => 0,
      dispatch, provider,
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(postComment).toHaveBeenCalledTimes(1);
    const [repoArg, prArg, body] = postComment.mock.calls[0];
    expect(repoArg).toBe('web-everything/web-everything');
    expect(prArg).toBe(42);
    expect(body.startsWith(STUCK_DISPATCH_MARKER)).toBe(true);
    expect(result.dispatchedCount).toBe(1);
  });

  it('never dispatches twice for the same episode — the marker comment already covers it', () => {
    const dispatch = vi.fn();
    const provider = { postComment: vi.fn(), currentRepo: vi.fn() };
    const pr = stuckFixPr({
      comments: [{ body: `${STUCK_DISPATCH_MARKER}\n\nepisode: 2026-09-23T17:00:00Z\n\n…` }],
    });
    const result = watchStuckPrs({
      repo: 'web-everything/web-everything', dryRun: false, now,
      listPrs: () => [pr], listTimelineEvents: oldActivity,
      readAgents: () => [], enrich: (a) => a, countLiveInspections: () => 0, dispatch, provider,
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.results.find((r) => r.num === 42).verdict).toBe('already-dispatched-this-episode');
  });

  it('a NEW episode (fresh activity, then stuck again) dispatches again', () => {
    const dispatch = vi.fn(() => ({ sessionSlug: 'inspect-42', agentId: null }));
    const provider = { postComment: vi.fn(), currentRepo: vi.fn(() => 'web-everything/web-everything') };
    const pr = stuckFixPr({
      comments: [{ body: `${STUCK_DISPATCH_MARKER}\n\nepisode: 2026-09-01T00:00:00Z\n\n…` }], // an OLD, different episode
    });
    const result = watchStuckPrs({
      repo: 'web-everything/web-everything', dryRun: false, now,
      listPrs: () => [pr], listTimelineEvents: oldActivity, // latest activity is 2026-09-23T17:00:00Z — a NEW episode
      readAgents: () => [], enrich: (a) => a, countLiveInspections: () => 0, dispatch, provider,
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result.dispatchedCount).toBe(1);
  });

  it('ROUND TRIP: the watch\'s own marker + the inspection agent\'s diagnosis never mint a new episode (review finding, PR #2553)', () => {
    // Sweep 1: genuinely stuck since T1 → dispatches and posts its marker.
    const postComment = vi.fn();
    const provider = { postComment, currentRepo: vi.fn(() => 'web-everything/web-everything') };
    const dispatch = vi.fn(() => ({ sessionSlug: 'inspect-42', agentId: null }));
    const t1 = '2026-09-23T17:00:00Z';
    const sweep = (at, timeline, comments) => watchStuckPrs({
      repo: 'web-everything/web-everything', dryRun: false, now: new Date(at).getTime(),
      listPrs: () => [stuckFixPr({ comments })], listTimelineEvents: () => timeline,
      readAgents: () => [], enrich: (a) => a, countLiveInspections: () => 0, dispatch, provider,
    });
    sweep('2026-09-23T19:00:00Z', [{ createdAt: t1, event: 'commented', body: 'a real human comment' }], []);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const marker = postComment.mock.calls[0][2];
    const diagnosis = '🔎 stuck-PR inspection\n\n**Stage:** fix\n…';

    // Sweep 2, well past the threshold AFTER the watch's own writes: feed sweep 1's marker (and the agent's own
    // diagnosis comment) back in as timeline events AND PR comments — exactly what GitHub would return.
    const result = sweep('2026-09-23T21:00:00Z', [
      { createdAt: t1, event: 'commented', body: 'a real human comment' },
      { createdAt: '2026-09-23T19:00:05Z', event: 'commented', body: marker },
      { createdAt: '2026-09-23T19:10:00Z', event: 'commented', body: `  ${diagnosis}` },
    ], [{ body: marker }, { body: diagnosis }]);
    expect(dispatch).toHaveBeenCalledTimes(1); // no second inspection for the same episode
    expect(postComment).toHaveBeenCalledTimes(1);
    const row = result.results.find((r) => r.num === 42);
    expect(row.verdict).toBe('already-dispatched-this-episode');
    expect(row.activityAt).toBe(t1);
  });

  /** Two sweeps over the same stuck PR, with sweep 1's successfully-posted comments fed back as sweep 2's. */
  function twoSweeps({ dispatch, postComment }) {
    const provider = { postComment, currentRepo: vi.fn(() => 'web-everything/web-everything') };
    const posted = () => postComment.mock.calls
      .filter((_, i) => postComment.mock.results[i].type === 'return').map((c) => ({ body: c[2] }));
    const sweep = () => watchStuckPrs({
      repo: 'web-everything/web-everything', dryRun: false, now,
      listPrs: () => [stuckFixPr({ comments: posted() })], listTimelineEvents: oldActivity,
      readAgents: () => [], enrich: (a) => a, countLiveInspections: () => 0, dispatch, provider,
    });
    return [sweep(), sweep()];
  }

  it('a marker-comment failure launches NO agent, so the next sweep\'s retry is the only dispatch (review finding, PR #2553)', () => {
    // A transient `gh pr comment` failure on sweep 1, then success: exactly ONE real agent is ever launched.
    const dispatch = vi.fn(() => ({ sessionSlug: 'inspect-42', agentId: 'a1' }));
    let calls = 0;
    const postComment = vi.fn(() => { calls += 1; if (calls === 1) throw new Error('gh: rate limited'); });
    const [first, second] = twoSweeps({ dispatch, postComment });
    expect(first.results.find((r) => r.num === 42).error).toMatch(/rate limited/);
    expect(first.dispatchedCount).toBe(0);
    expect(second.dispatchedCount).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('a PERSISTENT marker-comment failure never launches an agent at all — it cannot eat the concurrency cap', () => {
    const dispatch = vi.fn(() => ({ sessionSlug: 'inspect-42', agentId: 'a1' }));
    const postComment = vi.fn(() => { throw new Error('gh: auth'); });
    twoSweeps({ dispatch, postComment });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('the marker is posted BEFORE the agent is launched, and names the same session slug the dispatch uses', () => {
    const order = [];
    const dispatch = vi.fn(() => { order.push('dispatch'); return { sessionSlug: 'inspect-42', agentId: null }; });
    const postComment = vi.fn(() => { order.push('comment'); });
    watchStuckPrs({
      repo: 'web-everything/web-everything', dryRun: false, now,
      listPrs: () => [stuckFixPr()], listTimelineEvents: oldActivity,
      readAgents: () => [], enrich: (a) => a, countLiveInspections: () => 0,
      dispatch, provider: { postComment, currentRepo: vi.fn(() => 'web-everything/web-everything') },
    });
    expect(order).toEqual(['comment', 'dispatch']);
    expect(postComment.mock.calls[0][2]).toContain('`inspect-42`');
  });

  it('a launch that PROVABLY never started retracts that episode, so the next sweep retries it', () => {
    let calls = 0;
    const dispatch = vi.fn(() => {
      calls += 1;
      if (calls === 1) throw markNoInspectionStarted(Object.assign(new Error('spawn claude ENOENT --disallowedTools=x'), { code: 'ENOENT' }));
      return { sessionSlug: 'inspect-42', agentId: 'a2' };
    });
    const postComment = vi.fn();
    const [first, second] = twoSweeps({ dispatch, postComment });
    expect(first.results.find((r) => r.num === 42)).toMatchObject({ error: expect.stringMatching(/ENOENT/), retracted: true });
    const retraction = postComment.mock.calls[1][2];
    expect(retraction.startsWith(STUCK_DISPATCH_RETRACTED_MARKER)).toBe(true);
    expect(retraction).not.toContain('disallowedTools'); // raw error text stays in the log, never the public comment
    expect(second.dispatchedCount).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('a launch failure that MAY have started an agent (timeout, non-zero exit) never retracts — no duplicate', () => {
    const dispatch = vi.fn(() => { throw Object.assign(new Error('spawnSync claude ETIMEDOUT'), { code: 'ETIMEDOUT' }); });
    const postComment = vi.fn();
    const [first, second] = twoSweeps({ dispatch, postComment });
    expect(first.results.find((r) => r.num === 42).retracted).toBe(false);
    expect(postComment).toHaveBeenCalledTimes(1); // the marker only
    expect(second.results.find((r) => r.num === 42).verdict).toBe('already-dispatched-this-episode');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('a provable failure that REPEATS every sweep retracts at most once — bounded comments, bounded launches', () => {
    const dispatch = vi.fn(() => { throw markNoInspectionStarted(new Error('refusing to start from a lane checkout')); });
    const postComment = vi.fn();
    const provider = { postComment, currentRepo: vi.fn(() => 'web-everything/web-everything') };
    const posted = () => postComment.mock.calls.map((c) => ({ body: c[2] }));
    for (let i = 0; i < 5; i += 1) {
      watchStuckPrs({
        repo: 'web-everything/web-everything', dryRun: false, now,
        listPrs: () => [stuckFixPr({ comments: posted() })], listTimelineEvents: oldActivity,
        readAgents: () => [], enrich: (a) => a, countLiveInspections: () => 0, dispatch, provider,
      });
    }
    expect(dispatch).toHaveBeenCalledTimes(2); // first try + one retry
    expect(postComment).toHaveBeenCalledTimes(3); // marker, retraction, marker — then silence
  });

  it('respects the concurrency cap end-to-end — a full cap dispatches nothing', () => {
    const dispatch = vi.fn();
    const provider = { postComment: vi.fn(), currentRepo: vi.fn() };
    const result = watchStuckPrs({
      repo: 'web-everything/web-everything', dryRun: false, now,
      listPrs: () => [stuckFixPr()],
      listTimelineEvents: oldActivity,
      readAgents: () => [], enrich: (a) => a,
      countLiveInspections: () => 2, // already at the default cap of 2
      dispatch, provider,
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.results.find((r) => r.num === 42).deferredReason).toBe('concurrency-cap');
  });

  it('excludes review:human, draft, and stood-down PRs before ever fetching a timeline', () => {
    const listTimelineEvents = vi.fn(oldActivity);
    const result = watchStuckPrs({
      repo: 'web-everything/web-everything', dryRun: true, now,
      listPrs: () => [stuckFixPr({ number: 1, labels: [{ name: 'review:human' }] }), stuckFixPr({ number: 2, isDraft: true })],
      listTimelineEvents,
      readAgents: () => [], enrich: (a) => a, countLiveInspections: () => 0,
    });
    expect(listTimelineEvents).not.toHaveBeenCalled();
    expect(result.results).toEqual([{ num: 1, verdict: 'excluded' }, { num: 2, verdict: 'excluded' }]);
  });

  it('a failed agents read fails CLOSED — the whole sweep skips rather than guessing nothing is live', () => {
    const dispatch = vi.fn();
    const result = watchStuckPrs({
      repo: 'web-everything/web-everything', dryRun: false, now,
      listPrs: () => [stuckFixPr()],
      listTimelineEvents: oldActivity,
      readAgents: () => { throw new Error('claude agents failed'); },
      enrich: (a) => a, countLiveInspections: () => 0, dispatch,
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.results).toEqual([]);
  });

  it('refuses an unknown --repo', () => {
    expect(() => watchStuckPrs({ repo: 'someone/else', listPrs: () => [] })).toThrow(/is not a constellation repo/);
  });
});
