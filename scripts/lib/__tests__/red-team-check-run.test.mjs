// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { sealedStatusPath } from '../red-team-sealed-status.mjs';
import { redTeamMarker } from '../red-team-gate.mjs';
import { redTeamEnqueueHold } from '../drain-queue-safety.mjs';
import { readRedTeamGateSource } from '../red-team-check-run.mjs';

describe('redTeamGate.source cutover cascade', () => {
  it.each(['both', 'check-run', 'drain-scan'])('accepts mode %s from the environment', source => {
    expect(readRedTeamGateSource({ env: { WE_RED_TEAM_GATE_SOURCE: source }, tool: {}, platform: {} }))
      .toMatchObject({ value: { source }, sources: { source: 'env' } });
  });
  it('defaults to both and logs an invalid override with its fallback reason', () => {
    const lines = [];
    expect(readRedTeamGateSource({ env: {}, tool: {}, platform: {} }))
      .toMatchObject({ value: { source: 'both' }, sources: { source: 'standard' } });
    expect(readRedTeamGateSource({ env: { WE_RED_TEAM_GATE_SOURCE: 'unsafe' }, tool: {}, platform: {}, log: line => lines.push(line) }))
      .toMatchObject({ value: { source: 'both' }, sources: { source: 'standard' } });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/source="both".*standard.*ignored invalid.*unsafe/);
  });
  it('resolves platform then tool then env, ignoring invalid higher layers', () => {
    const layers = { platform: { source: 'drain-scan' }, tool: { redTeamGate: { source: 'both' } } };
    expect(readRedTeamGateSource({ ...layers, env: {} }).sources.source).toBe('tool');
    expect(readRedTeamGateSource({ ...layers, env: { WE_RED_TEAM_GATE_SOURCE: 'check-run' } }).value.source).toBe('check-run');
    expect(readRedTeamGateSource({ platform: layers.platform, tool: {}, env: {} }))
      .toMatchObject({ value: { source: 'drain-scan' }, sources: { source: 'platform' } });
    expect(readRedTeamGateSource({ ...layers, env: { WE_RED_TEAM_GATE_SOURCE: 'invalid' } }).sources.source).toBe('tool');
  });
});

const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);
const APP_ID = 5037855; // WE_APP_ID repository variable
let api;

describe('red-team check run contract', () => {
  beforeAll(async () => { api = await import('../red-team-check-run.mjs'); });
  const run = (over = {}) => ({ id: 10, name: 'red-team', head_sha: HEAD, external_id: 'o/r#7',
    app: { id: APP_ID }, status: 'completed', conclusion: 'success',
    started_at: '2026-11-07T10:00:00Z', ...over });

  // PR #6535 round 6: the recovery policy-clear writer posts only on a head with no run for this PR.
  describe('publishRedTeamPolicyClearCheck', () => {
    const ghWith = runs => vi.fn(args => args.includes('POST') ? '{}' : JSON.stringify({ total_count: runs.length, check_runs: runs }));
    const publish = gh => api.publishRedTeamPolicyClearCheck({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, gh });
    it('posts a head-bound success when the PR has no red-team run on the head', () => {
      // Stateful fake: verify-after-write must see the posted run (a static fake cannot model the write).
      const fake = liveGh({ initial: [run({ id: 1, head_sha: OLD_HEAD })] }); // an older head's success does not count here
      expect(publish(fake.gh)).toEqual({ ok: true });
      expect(fake.posts).toHaveLength(1);
      expect(fake.posts[0]).toMatchObject({ name: 'red-team', head_sha: HEAD, external_id: 'o/r#7', status: 'completed',
        conclusion: 'success', output: { title: 'Policy-clear: Red team clear' } });
    });
    it('needs no post when the head already shows success', () => {
      const gh = ghWith([run()]);
      expect(publish(gh)).toMatchObject({ ok: true });
      expect(gh.mock.calls.some(([args]) => args.includes('POST'))).toBe(false);
    });
    it.each([
      ['an in-progress round', [run({ status: 'in_progress', conclusion: null })]],
      ['a failed round', [run({ conclusion: 'failure' })]],
      ['another PR on the same head only', [run({ external_id: 'o/r#8' })]],
    ])('never overrides %s', (_name, runs) => {
      const gh = ghWith(runs);
      expect(publish(gh)).toMatchObject({ ok: false, reason: expect.stringContaining('policy-clear check not posted') });
      expect(gh.mock.calls.some(([args]) => args.includes('POST'))).toBe(false);
    });
    // #6535 round 10 (operator send-back): verify after write. A stateful fake GitHub: POST appends a run with the
    // next id; `onPost` lets a test insert a concurrent round's run at the moment the success is posted.
    const liveGh = ({ initial = [], onPost = () => {}, afterPost = () => {}, failReadAfterPost = false, failPostsAfter = Infinity } = {}) => {
      const runs = [...initial], posts = [];
      let nextId = Math.max(99, ...initial.map(r => r.id)) + 1; // GitHub ids only grow
      const gh = vi.fn((args, options) => {
        if (args.includes('POST')) {
          if (posts.length >= failPostsAfter) throw Error('HTTP 503');
          const payload = JSON.parse(options.input);
          posts.push(payload);
          onPost(runs, payload, () => nextId++);
          const id = nextId++;
          runs.push({ ...payload, id, app: { id: APP_ID }, conclusion: payload.conclusion ?? null });
          afterPost(runs, payload, () => nextId++);
          return JSON.stringify({ id });
        }
        if (failReadAfterPost && posts.length) throw Error('HTTP 502');
        return JSON.stringify({ total_count: runs.length, check_runs: runs });
      });
      return { gh, runs, posts };
    };
    const newest = runs => [...runs].sort((a, b) => b.id - a.id)[0];
    it('policy-clear cannot supersede a round started after its absence read', () => {
      // The absence read sees no run; a round then publishes in_progress; the policy-clear success lands NEWER.
      const fake = liveGh({ onPost: (runs, payload, id) => {
        if (payload.conclusion === 'success') runs.push(run({ id: id(), status: 'in_progress', conclusion: null }));
      } });
      expect(publish(fake.gh)).toMatchObject({ ok: false, reason: 'policy-clear yielded to a concurrent round' });
      expect(fake.posts.map(p => p.status)).toEqual(['completed', 'in_progress']);
      expect(fake.posts.at(-1)).toMatchObject({ name: 'red-team', head_sha: HEAD, external_id: 'o/r#7', status: 'in_progress',
        output: { title: 'Policy-clear: Red team in progress' } });
      expect(fake.posts.at(-1).conclusion).toBeUndefined();
      // The newest run (the authority merge-gate reads) is in_progress, never the policy-clear success.
      expect(newest(fake.runs)).toMatchObject({ status: 'in_progress' });
      expect(api.evaluateRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, checkRuns: fake.runs }))
        .toEqual({ ok: false, reason: 'red-team check run in progress or incomplete' });
    });
    it('mirrors a concurrent round that already finished with failure (the failure stays authoritative)', () => {
      const fake = liveGh({ onPost: (runs, payload, id) => {
        if (payload.conclusion === 'success') runs.push(run({ id: id(), conclusion: 'failure' }));
      } });
      expect(publish(fake.gh)).toMatchObject({ ok: false, reason: 'policy-clear yielded to a concurrent round' });
      expect(newest(fake.runs)).toMatchObject({ status: 'completed', conclusion: 'failure' });
    });
    it('does not yield to a round that started AND finished clean between its reads', () => {
      const fake = liveGh({ onPost: (runs, payload, id) => {
        if (payload.conclusion === 'success') runs.push(run({ id: id(), status: 'in_progress', conclusion: null }), run({ id: id() }));
      } });
      expect(publish(fake.gh)).toEqual({ ok: true });
      expect(fake.posts).toHaveLength(1);
    });
    // Self-review finding A: a retry must never trust its own unverified success (a lost POST response, a crash between
    // write and verify, or a failed yield) while a round it did not see is unfinished.
    it.each([
      ['in progress', run({ id: 100, status: 'in_progress', conclusion: null }), 'in_progress'],
      ['failed', run({ id: 100, conclusion: 'failure' }), 'failure'],
    ])('a retry over its own unverified success yields to a %s round (no false clear)', (_name, round, state) => {
      const fake = liveGh({ initial: [round, run({ id: 101, output: { title: 'Policy-clear: Red team clear' } })] });
      expect(publish(fake.gh)).toMatchObject({ ok: false, reason: 'policy-clear yielded to a concurrent round' });
      expect(fake.posts).toHaveLength(1);
      expect(fake.posts[0]).toMatchObject({ status: state === 'failure' ? 'completed' : 'in_progress' });
      expect(api.evaluateRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, checkRuns: fake.runs }).ok).toBe(false);
    });
    it('a round run that is newest owns the head: nothing is posted', () => {
      const fake = liveGh({ initial: [run({ id: 100, output: { title: 'Policy-clear: Red team clear' } }), run({ id: 101, status: 'in_progress', conclusion: null })] });
      expect(publish(fake.gh)).toMatchObject({ ok: false, reason: expect.stringContaining('a red-team round owns this head (in_progress)') });
      expect(fake.posts).toHaveLength(0);
    });
    // Self-review finding B: its own yield is told apart from a real round, so an orphan yield never strands the head.
    it('a retry over its own orphan yield (no round behind it) posts the success again and verifies it', () => {
      const fake = liveGh({ initial: [run({ id: 50, output: { title: 'Policy-clear: Red team clear' } }),
        run({ id: 51, status: 'in_progress', conclusion: null, output: { title: 'Policy-clear: Red team in progress' } })] });
      expect(publish(fake.gh)).toEqual({ ok: true });
      expect(fake.posts).toHaveLength(1);
      expect(newest(fake.runs)).toMatchObject({ status: 'completed', conclusion: 'success' });
    });
    it('corrects its own yield once the round it yielded to has finished clean', () => {
      const fake = liveGh({ initial: [run({ id: 50, status: 'in_progress', conclusion: null }), run({ id: 51 }),
        run({ id: 52, status: 'in_progress', conclusion: null, output: { title: 'Policy-clear: Red team in progress' } })] });
      expect(publish(fake.gh)).toEqual({ ok: true });
      expect(api.evaluateRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, checkRuns: fake.runs })).toMatchObject({ ok: true });
    });
    // Self-review finding C: with no round run requiring otherwise, a success that is not (yet) newest is never
    // answered with an in_progress post.
    it('posts nothing more when a lagging re-read does not show its success yet', () => {
      const posts = [];
      const gh = vi.fn((args, options) => {
        if (args.includes('POST')) { posts.push(JSON.parse(options.input)); return '{}'; }
        return JSON.stringify({ total_count: 0, check_runs: [] });
      });
      expect(publish(gh)).toMatchObject({ ok: false, reason: expect.stringContaining('policy-clear unverified: newest run shows none') });
      expect(posts).toHaveLength(1);
    });
    it('posts nothing more when another policy-clear writer\'s yield lands on top (no round needs it)', () => {
      const fake = liveGh({ afterPost: (runs, payload, id) => { if (payload.conclusion === 'success')
        runs.push(run({ id: id(), status: 'in_progress', conclusion: null, output: { title: 'Policy-clear: Red team in progress' } })); } });
      expect(publish(fake.gh)).toMatchObject({ ok: false, reason: expect.stringContaining('policy-clear unverified: newest run shows in_progress') });
      expect(fake.posts).toHaveLength(1);
      // The retry re-reads and posts the success again over the stray yield.
      const retry = liveGh({ initial: fake.runs });
      expect(publish(retry.gh)).toEqual({ ok: true });
      expect(newest(retry.runs)).toMatchObject({ status: 'completed', conclusion: 'success' });
    });
    it('the round writers\' payload carries no policy-clear marker', () => {
      expect(api.redTeamCheckRunPayload({ repo: 'o/r', pr: 7, headSha: HEAD, status: 'in_progress' }).output.title).toBe('Red team in progress');
      expect(api.redTeamCheckRunPayload({ repo: 'o/r', pr: 7, headSha: HEAD, status: 'finished', hold: null }).output.title).toBe('Red team clear');
    });
    it('a clean no-concurrency case publishes exactly one success and no extra in_progress post', () => {
      const fake = liveGh();
      expect(publish(fake.gh)).toEqual({ ok: true });
      expect(fake.posts).toHaveLength(1);
      expect(fake.posts[0]).toMatchObject({ status: 'completed', conclusion: 'success' });
      expect(api.evaluateRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, checkRuns: fake.runs })).toMatchObject({ ok: true });
    });
    it('another PR\'s run on the same head does not make policy-clear yield', () => {
      const fake = liveGh({ onPost: (runs, payload, id) => {
        if (payload.conclusion === 'success') runs.push(run({ id: id(), external_id: 'o/r#8', status: 'in_progress', conclusion: null }));
      } });
      expect(publish(fake.gh)).toEqual({ ok: true });
      expect(fake.posts).toHaveLength(1);
    });
    it('fails closed on a failed re-read: supersedes its own success with in_progress and returns ok:false', () => {
      const fake = liveGh({ failReadAfterPost: true });
      expect(publish(fake.gh)).toMatchObject({ ok: false, reason: 'policy-clear yielded to a concurrent round',
        detail: expect.stringContaining('re-read after publication failed') });
      expect(fake.posts.map(p => p.status)).toEqual(['completed', 'in_progress']);
      expect(newest(fake.runs)).toMatchObject({ status: 'in_progress' });
    });
    it('reports a superseding post that also fails (ok:false, both reasons named); the next retry corrects it', () => {
      const fake = liveGh({ failPostsAfter: 1, onPost: (runs, payload, id) => {
        if (payload.conclusion === 'success') runs.push(run({ id: id(), status: 'in_progress', conclusion: null }));
      } });
      expect(publish(fake.gh)).toMatchObject({ ok: false, reason: 'policy-clear yielded to a concurrent round',
        detail: expect.stringContaining('superseding in_progress not posted') });
      // The disclosed fail-open window (self-review M1): until the next pass, the unverified success is newest and
      // merge-gate reads it as clear over the unfinished round. Pinned so the residual stays visible, not hidden.
      expect(api.evaluateRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, checkRuns: fake.runs }).ok).toBe(true);
      // GitHub is back: the retry sees its own unverified success over the round and yields (finding A).
      const retry = liveGh({ initial: fake.runs });
      expect(publish(retry.gh)).toMatchObject({ ok: false, reason: 'policy-clear yielded to a concurrent round' });
      expect(newest(retry.runs)).toMatchObject({ status: 'in_progress' });
    });
    it('fails closed on an unreadable head or a missing app id', () => {
      expect(publish(vi.fn(() => { throw Error('offline'); }))).toMatchObject({ ok: false });
      const gh = ghWith([]);
      expect(api.publishRedTeamPolicyClearCheck({ repo: 'o/r', pr: 7, headSha: HEAD, appId: undefined, gh })).toMatchObject({ ok: false });
      expect(gh).not.toHaveBeenCalled();
    });
  });

  it('passes success on the exact head from the configured app', () => {
    expect(api.evaluateRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, checkRuns: [run()], appId: APP_ID })).toMatchObject({ ok: true });
  });

  it('success for PR A cannot authorize PR B sharing the same head SHA', () => {
    const gh = vi.fn(() => JSON.stringify({ total_count: 1, check_runs: [run()] }));
    expect(api.readRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, gh }).ok).toBe(true);
    expect(api.readRedTeamCheckFact({ repo: 'o/r', pr: 8, headSha: HEAD, appId: APP_ID, gh }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/o\/r#8.*external_id.*mismatching/) });
  });

  it('missing external_id fails closed even for a successful trusted check on the exact head', () => {
    expect(api.evaluateRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID,
      checkRuns: [run({ external_id: undefined })] }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/external_id missing/) });
  });

  it('selects the latest run for this PR without letting another PR supersede its pending round', () => {
    const checkRuns = [run(), run({ id: 11, status: 'in_progress', conclusion: null }),
      run({ id: 12, external_id: 'o/r#8' })];
    expect(api.evaluateRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, checkRuns }).ok).toBe(false);
    expect(api.evaluateRedTeamCheckFact({ repo: 'o/r', pr: 8, headSha: HEAD, appId: APP_ID, checkRuns }).ok).toBe(true);
  });

  it('publishes the PR identity in external_id and the summary', () => {
    const payload = api.redTeamCheckRunPayload({ repo: 'o/r', pr: 7, headSha: HEAD, status: 'finished', hold: null });
    const gh = vi.fn(() => JSON.stringify({ id: 123 }));
    expect(api.postRedTeamCheckRun({ repo: 'o/r', pr: 7, headSha: HEAD, payload, gh }).ok).toBe(true);
    const sent = JSON.parse(gh.mock.calls[0][1].input);
    expect(sent.external_id).toBe('o/r#7');
    expect(sent.output.summary).toContain('o/r#7');
  });

  it.each([
    ['failure holds', [run({ conclusion: 'failure' })], /fail/i],
    ['missing fails closed', [], /^no red-team check run on head$/],
    ['wrong app id holds', [run({ app: { id: 1 } })], /no red-team check run on head/],
    ['success only on a previous head holds', [run({ head_sha: OLD_HEAD })], /no red-team check run on head/],
    ['unreadable null fails closed', null, /unreadable/i],
    ['unreadable undefined fails closed', undefined, /unreadable/i],
    ['in progress holds', [run({ status: 'in_progress', conclusion: null })], /progress|pending|incomplete/i],
    ['another check name cannot clear red team', [run({ name: 'test' })], /no red-team check run on head/],
  ])('%s', (_name, checkRuns, reason) => {
    expect(api.evaluateRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, checkRuns, appId: APP_ID }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(reason) });
  });

  it.each([false, true])('uses the latest matching run regardless of input order (reverse=%s)', reverse => {
    const checkRuns = [run(), run({ id: 11, started_at: '2026-11-07T11:00:00Z', conclusion: 'failure' })];
    if (reverse) checkRuns.reverse();
    expect(api.evaluateRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, checkRuns, appId: APP_ID }).ok).toBe(false);
  });

  it('a newer wrong-app or other-head run cannot supersede the matching success', () => {
    expect(api.evaluateRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, checkRuns: [run(),
      run({ id: 11, app: { id: 1 }, conclusion: 'failure' }),
      run({ id: 12, head_sha: OLD_HEAD, conclusion: 'failure' })] }).ok).toBe(true);
  });

  it.each([false, true])('a newer pending run supersedes an older success (reverse=%s)', reverse => {
    const checkRuns = [run(), run({ id: 11, started_at: '2026-11-07T11:00:00Z', status: 'in_progress', conclusion: null })];
    if (reverse) checkRuns.reverse();
    expect(api.evaluateRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, checkRuns, appId: APP_ID }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/progress|pending|incomplete/i) });
  });

  it.each([undefined, null, '', 'invalid', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'missing or invalid WE_APP_ID fails closed before reading GitHub: %s', appId => {
      const gh = vi.fn(() => JSON.stringify({ total_count: 1, check_runs: [run()] }));
      expect(api.evaluateRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, checkRuns: [run()], appId }))
        .toMatchObject({ ok: false, reason: expect.stringMatching(/WE_APP_ID/) });
      expect(api.readRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, appId, gh }))
        .toMatchObject({ ok: false, reason: expect.stringMatching(/WE_APP_ID/) });
      expect(gh).not.toHaveBeenCalled();
    });

  it.each([
    ['truncated history containing a success', 101, 100],
    ['oversized history beyond the read bound', 101, 101],
    ['missing total count', undefined, 1],
  ])('incomplete check history fails closed with an operator fallback: %s', (_name, totalCount, count) => {
    const gh = vi.fn(() => JSON.stringify({ total_count: totalCount,
      check_runs: Array.from({ length: count }, (_, index) => run({ id: index + 10 })) }));
    expect(api.readRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, gh }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/incomplete.*operator.*inspect/i) });
    expect(gh).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['finished clear', 'finished', null, false, 'completed', 'success'],
    ['finished held', 'finished', 'post-accept red team has no recorded result on the live head', false, 'completed', 'failure'],
    ['sendBack', 'finished', null, true, 'completed', 'failure'],
    ['pending', 'pending', null, false, 'in_progress', undefined],
    ['running', 'running', null, false, 'in_progress', undefined],
  ])('payload: %s', (_name, status, hold, sendBack, expectedStatus, conclusion) => {
    const payload = api.redTeamCheckRunPayload({ repo: 'o/r', pr: 7, headSha: HEAD, status, hold, result: null, sendBack });
    expect(payload).toMatchObject({ name: 'red-team', head_sha: HEAD, external_id: 'o/r#7', status: expectedStatus,
      output: { title: expect.any(String), summary: expect.any(String) } });
    expect(payload.conclusion).toBe(conclusion);
    if (hold) expect(payload.output.summary).toContain(hold);
  });

  it('a real enqueue hold cannot become success even with a clean result', () => {
    const hold = redTeamEnqueueHold({ scheduled: true, comments: [], pr: 7, head: HEAD, env: {} });
    expect(hold).toEqual(expect.any(String));
    expect(api.redTeamCheckRunPayload({ repo: 'o/r', pr: 7, headSha: HEAD, status: 'finished', hold,
      result: { verdict: 'accept' }, sendBack: false }).conclusion).toBe('failure');
  });

  it('posts the check run to the requested repository using injected gh', async () => {
    const payload = api.redTeamCheckRunPayload({ repo: 'o/r', pr: 7, headSha: HEAD, status: 'finished', hold: null, result: null, sendBack: false });
    const gh = vi.fn(() => JSON.stringify({ id: 123 }));
    expect(await api.postRedTeamCheckRun({ repo: 'o/r', pr: 7, headSha: HEAD, payload, gh })).toMatchObject({ ok: true });
    expect(gh).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(gh.mock.calls)).toContain('repos/o/r/check-runs');
  });

  it('publication errors return a reason without throwing', async () => {
    const gh = vi.fn(() => { throw new Error('permission denied'); });
    expect(await api.postRedTeamCheckRun({ repo: 'o/r', pr: 7, headSha: HEAD,
      payload: { name: 'red-team', head_sha: HEAD, external_id: 'o/r#7', status: 'in_progress' }, gh }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/permission denied/) });
  });

  it('reads check runs from the exact head endpoint with injected gh', async () => {
    const gh = vi.fn(() => JSON.stringify({ total_count: 1, check_runs: [run()] }));
    expect(await api.readRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, gh })).toMatchObject({ ok: true });
    expect(JSON.stringify(gh.mock.calls)).toContain(`repos/o/r/commits/${HEAD}/check-runs`);
  });

  it.each(['API failure', 'malformed JSON', 'missing check_runs'])('reader fails closed: %s', async mode => {
    const gh = vi.fn(() => {
      if (mode === 'API failure') throw new Error('HTTP 403');
      return mode === 'malformed JSON' ? '{' : '{}';
    });
    expect(await api.readRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, gh }))
      .toMatchObject({ ok: false, reason: expect.any(String) });
  });
});

describe('GitHub-visible red-team publication hold (commit status)', () => {
  const head = 'd'.repeat(40);
  it('posts a head-bound failure or success status on its own context, with a bounded single-line description', async () => {
    const { postRedTeamPublicationHold } = await import('../red-team-check-run.mjs');
    const calls = [];
    const gh = (args, opts) => { calls.push({ args, body: JSON.parse(opts.input) }); return ''; };
    expect(postRedTeamPublicationHold({ repo: 'o/r', pr: 7, headSha: head, held: true, reason: `x\n${'y'.repeat(300)}`, gh })).toEqual({ ok: true });
    expect(postRedTeamPublicationHold({ repo: 'o/r', pr: 7, headSha: head, held: false, gh })).toEqual({ ok: true });
    expect(calls.map(c => c.args.slice(0, 4))).toEqual([['api', `repos/o/r/statuses/${head}`, '--method', 'POST'], ['api', `repos/o/r/statuses/${head}`, '--method', 'POST']]);
    expect(calls.map(c => [c.body.state, c.body.context])).toEqual([['failure', 'red-team/publication #7'], ['success', 'red-team/publication #7']]);
    expect(calls[0].body.description).toHaveLength(140);
    expect(calls[0].body.description).not.toMatch(/\n/);
  });
  it('refuses an invalid identity and reports a failed post', async () => {
    const { postRedTeamPublicationHold } = await import('../red-team-check-run.mjs');
    const gh = vi.fn(() => { throw Error('HTTP 503'); });
    expect(postRedTeamPublicationHold({ repo: 'o/r', pr: 7, headSha: 'nope', held: true, gh })).toMatchObject({ ok: false });
    expect(gh).not.toHaveBeenCalled();
    expect(postRedTeamPublicationHold({ repo: 'o/r', pr: 7, headSha: head, held: true, gh })).toMatchObject({ ok: false, definite: false, reason: expect.stringContaining('HTTP 503') });
  });
  it('detects a definite 4xx rejection from the full error text, even past the reason truncation', async () => {
    const { postRedTeamPublicationHold } = await import('../red-team-check-run.mjs');
    const long = Object.assign(Error(`${'x'.repeat(400)} Resource not accessible by integration (HTTP 403)`), { stderr: '' });
    const result = postRedTeamPublicationHold({ repo: 'o/r', pr: 7, headSha: head, held: true, gh: () => { throw long; } });
    expect(result).toMatchObject({ ok: false, definite: true });
    expect(result.reason).not.toMatch(/HTTP 403/);
    expect(postRedTeamPublicationHold({ repo: 'o/r', pr: 7, headSha: head, held: true,
      gh: () => { throw Object.assign(Error('gh failed'), { stderr: 'gh: Validation Failed (HTTP 422)' }); } })).toMatchObject({ definite: true });
  });
  it('fails closed when the combined summary carries this PR failure hold but the history is empty (#6535 :145)', async () => {
    const { evaluateRedTeamPublicationHold: evaluateAny, redTeamPublicationContext } = await import('../red-team-check-run.mjs');
    const context = redTeamPublicationContext(7);
    const combined = { total_count: 1, statuses: [{ context, state: 'failure', id: 5 }] };
    expect(evaluateAny({ pr: 7, combined, statuses: [] })).toMatchObject({ ok: false });
    expect(evaluateAny({ pr: 7, combined, statuses: [{ id: 3, context: 'other', state: 'success' }] })).toMatchObject({ ok: false });
  });
  it('evaluates absent, cleared, held, and incomplete combined status', async () => {
    const { evaluateRedTeamPublicationHold: evaluateAny, redTeamPublicationContext } = await import('../red-team-check-run.mjs');
    const evaluate = input => evaluateAny({ pr: 7, ...input }), context = redTeamPublicationContext(7);
    const combined = { total_count: 1, statuses: [{ context, state: 'failure' }] };
    const bot = { login: 'web-everything[bot]' }, stranger = { login: 'someone-else' };
    expect(evaluateAny({ combined, statuses: [] })).toMatchObject({ ok: false, reason: expect.stringMatching(/PR number/) });
    expect(evaluate({ combined: { total_count: 1, statuses: [{ context: 'ci', state: 'failure' }] } })).toMatchObject({ ok: true });
    expect(evaluate({ combined, statuses: [{ id: 2, context, state: 'success', creator: bot }, { id: 1, context, state: 'failure', creator: bot }] }))
      .toMatchObject({ ok: true, reason: expect.stringMatching(/cleared/) });
    for (const state of ['failure', 'pending', 'error', undefined])
      expect(evaluate({ combined, statuses: [{ id: 1, context, state, creator: stranger }] })).toMatchObject({ ok: false });
    expect(evaluate({ combined: { total_count: 2, statuses: [] } })).toMatchObject({ ok: false, reason: expect.stringMatching(/incomplete/) });
    expect(evaluate({ combined: null })).toMatchObject({ ok: false });
    expect(evaluate({ combined, statuses: null })).toMatchObject({ ok: false, reason: expect.stringMatching(/history unreadable/) });
  });
  it('an untrusted success never clears a hold, whatever its order in the response', async () => {
    const { evaluateRedTeamPublicationHold: evaluateAny, redTeamPublicationContext } = await import('../red-team-check-run.mjs');
    const evaluate = input => evaluateAny({ pr: 7, ...input }), context = redTeamPublicationContext(7);
    const combined = { total_count: 1, statuses: [{ context, state: 'success' }] };
    const statuses = [{ id: 1, context, state: 'failure', creator: { login: 'web-everything[bot]' } },
      { id: 9, context, state: 'success', creator: { login: 'github-actions[bot]' } }];
    expect(evaluate({ combined, statuses })).toMatchObject({ ok: false, reason: expect.stringMatching(/GitHub-visible hold/) });
    // Only untrusted successes and no hold: nothing to honour.
    expect(evaluate({ combined, statuses: [statuses[1]] })).toMatchObject({ ok: true });
    // A full page with no decision cannot rule out an older hold.
    const page = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, context, state: 'success', creator: { login: 'x' } }));
    expect(evaluate({ combined, statuses: page })).toMatchObject({ ok: false, reason: expect.stringMatching(/100-status bound/) });
  });
  it('reads the full history only when the context exists', async () => {
    const { readRedTeamPublicationHoldFact, redTeamPublicationContext } = await import('../red-team-check-run.mjs');
    const context = redTeamPublicationContext(7);
    const calls = [];
    const gh = args => { calls.push(args[1]); return JSON.stringify({ total_count: 0, statuses: [] }); };
    expect(readRedTeamPublicationHoldFact({ repo: 'o/r', pr: 7, headSha: head, gh })).toMatchObject({ ok: true });
    expect(calls).toEqual([`repos/o/r/commits/${head}/status?per_page=100`]);
    const gh2 = args => (/\/status\?/.test(args[1]) ? JSON.stringify({ total_count: 1, statuses: [{ context, state: 'failure' }] })
      : JSON.stringify([{ id: 1, context, state: 'failure', creator: { login: 'web-everything[bot]' } }]));
    expect(readRedTeamPublicationHoldFact({ repo: 'o/r', pr: 7, headSha: head, gh: gh2 })).toMatchObject({ ok: false });
    // The bare, PR-less context (never this PR's) is not read as this PR's hold.
    const gh3 = args => (/\/status\?/.test(args[1]) ? JSON.stringify({ total_count: 1, statuses: [{ context: 'red-team/publication', state: 'failure' }] })
      : JSON.stringify([]));
    expect(readRedTeamPublicationHoldFact({ repo: 'o/r', pr: 7, headSha: head, gh: gh3 })).toMatchObject({ ok: true });
  });
});

describe('the publication hold is bound to its PR, not only its head (#6535 round 4)', () => {
  const head = 'e'.repeat(40);
  const bot = { login: 'web-everything[bot]' };
  it('a confirmed clear by another PR sharing the head never clears this PR\'s hold', async () => {
    const { postRedTeamPublicationHold, readRedTeamPublicationHoldFact } = await import('../red-team-check-run.mjs');
    const posted = [];
    const writer = (args, opts) => { posted.push({ id: posted.length + 1, creator: bot, ...JSON.parse(opts.input) }); return ''; };
    expect(postRedTeamPublicationHold({ repo: 'o/r', pr: 7, headSha: head, held: true, gh: writer })).toEqual({ ok: true });
    expect(postRedTeamPublicationHold({ repo: 'o/r', pr: 8, headSha: head, held: false, gh: writer })).toEqual({ ok: true });
    expect(new Set(posted.map(s => s.context)).size).toBe(2);
    const reader = args => {
      const newestFirst = [...posted].reverse();
      if (/\/status\?/.test(args[1])) {
        const latest = [...new Map([...posted].map(s => [s.context, s])).values()];
        return JSON.stringify({ total_count: latest.length, statuses: latest });
      }
      return JSON.stringify(newestFirst);
    };
    expect(readRedTeamPublicationHoldFact({ repo: 'o/r', pr: 7, headSha: head, gh: reader }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/GitHub-visible hold/) });
    expect(readRedTeamPublicationHoldFact({ repo: 'o/r', pr: 8, headSha: head, gh: reader })).toMatchObject({ ok: true });
  });
  it('refuses to post or read a hold without a valid PR number', async () => {
    const { postRedTeamPublicationHold, readRedTeamPublicationHoldFact } = await import('../red-team-check-run.mjs');
    const gh = vi.fn(() => '');
    for (const pr of [undefined, 0, -1, '7x', 1.5]) {
      expect(postRedTeamPublicationHold({ repo: 'o/r', pr, headSha: head, held: true, gh })).toMatchObject({ ok: false });
      expect(readRedTeamPublicationHoldFact({ repo: 'o/r', pr, headSha: head, gh })).toMatchObject({ ok: false });
    }
    expect(gh).not.toHaveBeenCalled();
  });
});

describe('bounded reads (round-4 finding): every red-team GitHub read asks for one 100-item page within 4 MiB and 60 s', () => {
  const head = 'f'.repeat(40);
  it('bounds check-run reads to 100 results and 4 MiB', async () => {
    const { readRedTeamCheckFact } = await import('../red-team-check-run.mjs');
    const calls = [];
    const gh = (args, opts) => { calls.push({ args, opts }); return JSON.stringify({ total_count: 0, check_runs: [] }); };
    readRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: head, appId: 5037855, gh });
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['api', `repos/o/r/commits/${head}/check-runs?check_name=red-team&filter=all&per_page=100`]);
    expect(calls[0].opts).toMatchObject({ maxBuffer: 4 * 1024 * 1024, timeout: 60_000 });
  });
  it('bounds both publication-hold reads the same way', async () => {
    const { readRedTeamPublicationHoldFact, redTeamPublicationContext } = await import('../red-team-check-run.mjs');
    const calls = [];
    const gh = (args, opts) => {
      calls.push({ args, opts });
      return /\/status\?/.test(args[1]) ? JSON.stringify({ total_count: 1, statuses: [{ context: redTeamPublicationContext(7), state: 'failure' }] }) : '[]';
    };
    readRedTeamPublicationHoldFact({ repo: 'o/r', pr: 7, headSha: head, gh });
    expect(calls.map(c => c.args[1])).toEqual([`repos/o/r/commits/${head}/status?per_page=100`, `repos/o/r/commits/${head}/statuses?per_page=100`]);
    for (const c of calls) expect(c.opts).toMatchObject({ maxBuffer: 4 * 1024 * 1024, timeout: 60_000 });
  });
  it('a response over the 100-run bound fails closed', async () => {
    const { readRedTeamCheckFact } = await import('../red-team-check-run.mjs');
    const gh = () => JSON.stringify({ total_count: 101, check_runs: Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })) });
    expect(readRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: head, appId: 5037855, gh }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/100-run bound/) });
  });
});

// #6535 operator send-backs (2026-11-12, R903) and ruling R907 (setting R905): the daemon never sets WE_APP_ID, the
// reviewer App (5267537) holds only checks:read, and every installed App gets HTTP 403 on Actions variables. The id is
// the `redTeamGate.appId` setting (env WE_APP_ID as its top layer), never a runtime variable read, and every red-team
// write runs as today's App (5037855), whatever role the calling daemon plays.
describe('WE App id resolver and the red-team writer identity (#6535 operator send-back, R907)', () => {
  const WE_APP = '5037855', REVIEWER_APP = 5267537;
  const head = 'c'.repeat(40);
  beforeAll(async () => { api = await import('../red-team-check-run.mjs'); });
  // Models GitHub: the App a call authenticates as follows the shim role in its env. Only today's App may create a
  // check run (a role App has checks:read: HTTP 403); every App gets HTTP 403 on an Actions variable read.
  const daemonGh = () => {
    const runs = [], calls = [];
    let nextId = 100;
    const appOf = env => env?.WE_GITHUB_APP_ROLE === 'legacy' ? Number(WE_APP) : REVIEWER_APP;
    const run = vi.fn((args, options = {}) => {
      calls.push({ args, role: options.env?.WE_GITHUB_APP_ROLE, app: appOf(options.env) });
      if (String(args[1]).includes('/actions/variables/')) throw Error('HTTP 403: Resource not accessible by integration');
      if (args.includes('POST')) {
        if (appOf(options.env) !== Number(WE_APP)) throw Error('HTTP 403: Resource not accessible by integration');
        const payload = JSON.parse(options.input);
        runs.push({ ...payload, id: nextId++, app: { id: appOf(options.env) }, conclusion: payload.conclusion ?? null });
        return '{}';
      }
      return JSON.stringify({ total_count: runs.length, check_runs: runs });
    });
    return { run, runs, calls };
  };
  const daemonEnv = () => ({ PATH: '/bin', WE_GITHUB_APP_ROLE: 'reviewer' }); // the review daemon: no WE_APP_ID
  const args = { repo: 'o/r', pr: 7, headSha: head };

  it('(1) a daemon env without WE_APP_ID resolves 5037855 from the setting; the writer gets that id, never 5267537, and no variable is read', () => {
    const fake = daemonGh();
    const publish = vi.fn(api.publishRedTeamPolicyClearCheck);
    const result = api.createPolicyClearPublisher({ env: daemonEnv(), run: fake.run, publish })(args);
    expect(result).toEqual({ ok: true });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0].appId).toBe(WE_APP);
    expect(publish.mock.calls.every(([a]) => Number(a.appId) !== REVIEWER_APP)).toBe(true);
    expect(fake.calls.filter(c => String(c.args[1]).includes('/actions/variables/'))).toEqual([]);
    expect(fake.runs).toHaveLength(1);
    expect(fake.runs[0]).toMatchObject({ app: { id: Number(WE_APP) }, conclusion: 'success', external_id: 'o/r#7' });
  });

  it('the shipped setting is the trusted App id 5037855, resolved from the tool layer with its source logged', () => {
    const lines = [];
    expect(api.resolveWeAppId({ env: {}, platform: {}, log: line => lines.push(line) }))
      .toEqual({ ok: true, appId: WE_APP, source: 'tool' });
    expect(lines).toEqual([expect.stringMatching(/redTeamGate\.appId: appId=5037855 \(tool\)/)]);
  });

  it('(2) a reviewer-role identity in the env is never used for a write', () => {
    const fake = daemonGh();
    api.createPolicyClearPublisher({ env: daemonEnv(), run: fake.run })(args);
    const writes = fake.calls.filter(c => c.args.includes('POST'));
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every(c => c.role === 'legacy' && c.app === Number(WE_APP))).toBe(true);
    // Every writer, not only policy-clear: the round writer's check post and the publication-hold status too.
    const seen = [];
    const gh = (a, options) => { seen.push(options.env); return '{}'; };
    const env = { ...daemonEnv(), WE_GITHUB_APP_ROLE: 'merger', KEEP: '1' };
    api.postRedTeamCheckRun({ ...args, gh, env, payload: api.redTeamCheckRunPayload({ ...args, status: 'in_progress' }) });
    api.postRedTeamPublicationHold({ ...args, held: true, gh, env });
    expect(seen).toEqual([{ ...env, WE_GITHUB_APP_ROLE: 'legacy' }, { ...env, WE_GITHUB_APP_ROLE: 'legacy' }]);
    expect(env.WE_GITHUB_APP_ROLE).toBe('merger'); // the caller's env is never mutated
    // An inherited role-App token never reaches the write (the shim's inherited-token path or a bare gh would use it).
    const inherited = { ...env, GH_TOKEN: 'fixture-role-token', GITHUB_TOKEN: 'x', WE_GH_AUTH_TOKEN_HASH: 'h', WE_GH_AUTH_SOURCE: 'cache', WE_GH_AUTH_INSTALLATION: '1' };
    expect(api.redTeamWriterEnv(inherited)).toEqual({ ...env, WE_GITHUB_APP_ROLE: 'legacy' });
    expect(inherited.GH_TOKEN).toBe('fixture-role-token');
  });

  it('an on-demand refresh for the legacy role mints today\'s App only, never a configured role App', async () => {
    const { buildIdentityChain, LEGACY_ROLE } = await import('../github-app-identity.mjs');
    const app = id => ({ appId: id, installations: { o: '1' }, key: { file: '/k.pem' } });
    const identity = { roles: { reviewer: app('5267537'), worker: app('5267514') }, invalid: [], anyConfigured: true, callerRoles: {} };
    const chain = buildIdentityChain({ requestedRole: LEGACY_ROLE, identity, env: {}, cachePath: '/c/web-everything.json' });
    expect(chain.steps).toEqual([]);
    expect(chain.candidates.map(c => c.role)).toEqual([LEGACY_ROLE]);
    expect(buildIdentityChain({ requestedRole: 'reviewer', identity, env: {}, cachePath: '/c/web-everything.json' })
      .candidates.map(c => c.role)).toEqual(['reviewer', 'worker', LEGACY_ROLE]);
  });

  it.each([
    ['unreadable (missing file)', { path: new URL('file:///nonexistent/red-team.json') }],
    ['without appId', { tool: { redTeamGate: { source: 'both' } } }],
    ['empty', { tool: { redTeamGate: { appId: '' } } }],
    ['not an id', { tool: { redTeamGate: { appId: 'abc' } } }],
    ['zero', { tool: { redTeamGate: { appId: 0 } } }],
    ['at an unreadable path', { path: new URL('data:application/json,{not json') }],
  ])('(3) a setting that is %s yields the existing fail-closed reason, with no publication', (_label, layer) => {
    const fake = daemonGh();
    const publish = vi.fn(api.publishRedTeamPolicyClearCheck);
    const resolveAppId = () => api.resolveWeAppId({ env: daemonEnv(), platform: {}, ...layer });
    const result = api.createPolicyClearPublisher({ env: daemonEnv(), run: fake.run, publish, resolveAppId })(args);
    expect(result).toMatchObject({ ok: false, reason: 'WE_APP_ID unset or invalid; configure the WE App repository variable',
      detail: expect.stringMatching(/redTeamGate\.appId setting missing or invalid/) });
    expect(publish).not.toHaveBeenCalled();
    expect(fake.calls).toEqual([]); // no POST, and no variable read as a fallback
    // A reader handed the unresolved id keeps the same reason and reads no check runs.
    const read = vi.fn();
    expect(api.readRedTeamCheckFact({ ...args, appId: resolveAppId().appId, gh: read }))
      .toEqual({ ok: false, reason: 'WE_APP_ID unset or invalid; configure the WE App repository variable' });
    expect(read).not.toHaveBeenCalled();
  });

  it('cascade: platform < tool < WE_APP_ID env; an invalid layer is ignored, never read as "no id"', () => {
    const tool = { redTeamGate: { appId: 5037855 } };
    expect(api.resolveWeAppId({ env: {}, tool, platform: {} })).toEqual({ ok: true, appId: WE_APP, source: 'tool' });
    expect(api.resolveWeAppId({ env: {}, tool, platform: { appId: 77 } })).toEqual({ ok: true, appId: WE_APP, source: 'tool' });
    expect(api.resolveWeAppId({ env: {}, tool: {}, platform: { appId: 77 } })).toEqual({ ok: true, appId: '77', source: 'platform' });
    expect(api.resolveWeAppId({ env: { WE_APP_ID: '42' }, tool, platform: { appId: 77 } })).toEqual({ ok: true, appId: '42', source: 'env' });
    expect(api.resolveWeAppId({ env: { WE_APP_ID: 'bad' }, tool, platform: {} })).toEqual({ ok: true, appId: WE_APP, source: 'tool' });
    expect(api.resolveWeAppId({ env: { WE_APP_ID: '' }, tool, platform: {} })).toEqual({ ok: true, appId: WE_APP, source: 'tool' });
    // A log that throws never changes the answer.
    expect(api.resolveWeAppId({ env: {}, tool, platform: {}, log: () => { throw Error('closed'); } })).toMatchObject({ ok: true, appId: WE_APP });
  });

  it('the gh shim gives the legacy role today\'s App only, never a configured role App', async () => {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { spawnSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    // Render in a plain node child: the shim embeds helpers via Function#toString, which vitest's transform rewrites.
    const renderGhShimScript = options => {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e',
        `const m = await import(${JSON.stringify(fileURLToPath(new URL('../gh-app-shim.mjs', import.meta.url)))}); process.stdout.write(m.renderGhShimScript(JSON.parse(process.argv[1])));`,
        JSON.stringify(options)], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      if (r.status !== 0) throw Error(`shim render failed: ${r.stderr}`);
      return r.stdout;
    };
    const dir = mkdtempSync(join(tmpdir(), 'red-team-writer-shim-'));
    try {
      const cache = (name, token) => {
        const path = join(dir, `${name}.json`);
        // Synthetic fixture values only.
        writeFileSync(path, JSON.stringify({ v: 2, installationId: '1', appId: name, token, expiresAt: new Date(Date.now() + 3600e3).toISOString() }));
        return path;
      };
      const gh = join(dir, 'real-gh');
      writeFileSync(gh, `#!${process.execPath}\nprocess.stdout.write(String(process.env.GH_TOKEN));\n`);
      chmodSync(gh, 0o755);
      const shim = join(dir, 'shim.cjs');
      writeFileSync(shim, renderGhShimScript({ realGhPath: gh, cachePath: cache('legacy', 'fixture-legacy'),
        ghThrottleCliPath: join(dir, 'missing-throttle'), refreshCliPath: join(dir, 'missing-refresh'),
        roleTable: { reviewer: { cachePath: cache('reviewer', 'fixture-reviewer'), installations: { o: '1' } },
          worker: { cachePath: cache('worker', 'fixture-worker'), installations: { o: '1' } } } }));
      const as = role => spawnSync(process.execPath, [shim, 'api', 'rate_limit'], { cwd: dir, encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: dir, WE_GITHUB_APP_ROLE: role } });
      const legacy = as('legacy');
      expect(`${legacy.stdout}|${legacy.status}|${String(legacy.error ?? '')}|${legacy.stderr.slice(0, 600)}`)
        .toMatch(/^fixture-legacy\|0\|/);
      expect(legacy.stderr).not.toMatch(/using the worker App|unavailable/);
      expect(as('reviewer').stdout).toBe('fixture-reviewer');
      expect(as(api.redTeamWriterEnv({ WE_GITHUB_APP_ROLE: 'reviewer' }).WE_GITHUB_APP_ROLE).stdout).toBe('fixture-legacy');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  // Round 11 coverage (#6535): legacy App or nothing when today's App token is unavailable. A daemon refuses (no role
  // App, no personal login); its one on-demand refresh asks for the legacy role only.
  it('the gh shim with no legacy token never uses a configured role App: a daemon refuses, its refresh asks for legacy only', async () => {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { spawnSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const renderGhShimScript = options => {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e',
        `const m = await import(${JSON.stringify(fileURLToPath(new URL('../gh-app-shim.mjs', import.meta.url)))}); process.stdout.write(m.renderGhShimScript(JSON.parse(process.argv[1])));`,
        JSON.stringify(options)], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      if (r.status !== 0) throw Error(`shim render failed: ${r.stderr}`);
      return r.stdout;
    };
    const dir = mkdtempSync(join(tmpdir(), 'red-team-writer-shim-miss-'));
    try {
      const cache = (name, token) => {
        const path = join(dir, `${name}.json`);
        // Synthetic fixture values only.
        writeFileSync(path, JSON.stringify({ v: 2, installationId: '1', appId: name, token, expiresAt: new Date(Date.now() + 3600e3).toISOString() }));
        return path;
      };
      const gh = join(dir, 'real-gh');
      writeFileSync(gh, `#!${process.execPath}\nprocess.stdout.write('ran:' + String(process.env.GH_TOKEN));\n`);
      chmodSync(gh, 0o755);
      // The refresh CLI records the role it was asked for and mints nothing (today's App stays unavailable).
      const refreshLog = join(dir, 'refresh.log');
      const refresh = join(dir, 'refresh.cjs');
      writeFileSync(refresh, `require('node:fs').appendFileSync(${JSON.stringify(refreshLog)}, process.argv.slice(2).join(' ') + '\\n');\n`);
      const shim = join(dir, 'shim.cjs');
      writeFileSync(shim, renderGhShimScript({ realGhPath: gh, cachePath: join(dir, 'legacy-absent.json'),
        ghThrottleCliPath: join(dir, 'missing-throttle'), refreshCliPath: refresh,
        roleTable: { reviewer: { cachePath: cache('reviewer', 'fixture-reviewer'), installations: { o: '1' } },
          worker: { cachePath: cache('worker', 'fixture-worker'), installations: { o: '1' } } } }));
      const call = extra => spawnSync(process.execPath, [shim, 'api', 'rate_limit'], { cwd: dir, encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: dir, WE_GITHUB_APP_ROLE: 'legacy', ...extra } });

      const daemon = call({ WE_GH_DAEMON_CALLER: 'review-daemon', WE_GH_AUTH_PERSONAL_FALLBACK: 'refuse' });
      expect(daemon.status).toBe(1);
      expect(daemon.stdout).toBe(''); // gh never ran: no role App token, no personal login
      expect(daemon.stderr).toMatch(/REFUSING personal-auth fallback for daemon caller "review-daemon" \(role legacy/);
      expect(`${daemon.stdout}${daemon.stderr}`).not.toMatch(/fixture-reviewer|fixture-worker|using the (reviewer|worker) App/);
      expect(existsSync(refreshLog) ? readFileSync(refreshLog, 'utf8') : '').toBe('--role=legacy\n');

      // An interactive caller gets no role App either (it may use the operator's own login, as for any App miss).
      const interactive = call({});
      expect(interactive.stdout).toBe('ran:undefined');
      expect(`${interactive.stdout}${interactive.stderr}`).not.toMatch(/fixture-reviewer|fixture-worker/);
      // Contrast: the reviewer role with the same caches does use its App, so the refusal above is the legacy guard.
      expect(call({ WE_GITHUB_APP_ROLE: 'reviewer' }).stdout).toBe('ran:fixture-reviewer');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  // Round 11 coverage (#6535): ensureFreshGithubAppEnv's explicit `legacy` branch mints today's App only. The process
  // role (env or caller map) cannot override it, and `legacy` is never selectable from the env.
  describe('ensureFreshGithubAppEnv with role legacy (the shim\'s on-demand refresh for the red-team writer)', () => {
    const TODAY = '5037855', REVIEWER = '5267537', WORKER = '5267514';
    const dirs = [];
    afterEach(async () => {
      const { rmSync } = await import('node:fs');
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });
    const setup = async () => {
      const { mkdtempSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');
      const { ensureFreshGithubAppEnv } = await import('../github-app-auth-env.mjs');
      const { resolveDeliveryIdentity, ROLE_REQUIRED_PERMISSIONS } = await import('../github-app-identity.mjs');
      const { OWNER_INSTALLATIONS } = await import('../github-app-installations.mjs');
      const dir = mkdtempSync(join(tmpdir(), 'red-team-legacy-refresh-'));
      dirs.push(dir);
      const installations = { 'web-everything': '91', 'frontier-ui': '92', plateauapp: '93' };
      // Both a process role App and the worker App are configured, so neither the role resolution (auth-env) nor
      // the chain builder (`buildIdentityChain`'s legacy order) can let a role App stand in unnoticed.
      const identity = resolveDeliveryIdentity({ tool: {
        reviewer: { appId: REVIEWER, installations, key: { file: '/keys/reviewer.pem' } },
        worker: { appId: WORKER, installations, key: { file: '/keys/worker.pem' } } } });
      const minted = [];
      const env = { WE_GITHUB_APP_ID: TODAY, WE_GITHUB_APP_INSTALLATION_ID: OWNER_INSTALLATIONS['web-everything'],
        WE_GITHUB_APP_PRIVATE_KEY_PATH: '/k', PATH: '/usr/bin', WE_GITHUB_APP_ROLE: 'reviewer' };
      const run = (opts = {}) => ensureFreshGithubAppEnv({
        env, cachePath: join(dir, 'web-everything.json'), statusPath: join(dir, 'status.json'), now: Date.now(), identity,
        caller: 'review-daemon.mjs', daemon: false, policy: { auth: 'app' }, // never the host's auth preference
        mint: async ({ appId, installationId }) => {
          minted.push(String(appId));
          if (opts.failApp === String(appId)) throw new Error('HTTP 401 bad credentials');
          return { token: `tok-${appId}-${installationId}`, expiresAt: new Date(Date.now() + 3600e3).toISOString(),
            permissions: { ...ROLE_REQUIRED_PERMISSIONS.worker, statuses: 'read', merge_queues: 'write' } };
        },
        getInstallationInfo: async () => ({ repositorySelection: 'all' }), canReadKey: () => true,
        log: { error: () => {} }, writeStatus: () => {}, writeCallerStatus: () => {},
        installShim: async () => ({ ok: true }), perOwner: true, ...opts });
      return { run, minted, env };
    };

    it('role legacy refreshes today\'s App only, although the process plays the reviewer role', async () => {
      const t = await setup();
      const r = await t.run({ role: 'legacy' });
      expect(r).toMatchObject({ applied: true, role: 'legacy', requestedRole: 'legacy' });
      expect(t.minted.length).toBeGreaterThan(0);
      expect(t.minted.every(id => id === TODAY)).toBe(true);
      expect(t.minted).not.toContain(REVIEWER);
      expect(t.minted).not.toContain(WORKER);
    });

    it('role legacy with today\'s App unavailable applies nothing; no role App stands in', async () => {
      const t = await setup();
      const r = await t.run({ role: 'legacy', failApp: TODAY });
      expect(r.applied).not.toBe(true);
      expect(['reviewer', 'worker']).not.toContain(r.role);
      expect(t.minted).not.toContain(REVIEWER);
      expect(t.minted).not.toContain(WORKER);
      expect(r.fallbackFrom ?? []).toEqual([]);
    });

    it('contrast: the process role (reviewer from the env) mints the reviewer App first; legacy in the env is not a role', async () => {
      const t = await setup();
      expect(await t.run()).toMatchObject({ applied: true, role: 'reviewer', requestedRole: 'reviewer' });
      expect(t.minted[0]).toBe(REVIEWER);
      const { resolveRequestedRole } = await import('../github-app-identity.mjs');
      expect(resolveRequestedRole({ env: { WE_GITHUB_APP_ROLE: 'legacy' }, caller: 'no-such-caller.mjs', callerRoles: {} }).role).not.toBe('legacy');
    });
  });
});

// Round 11 coverage (#6535, ruling: block): the promised whole-head refusal of unordered check-run ids. A matching run
// whose id cannot order it (missing, non-integer, zero, negative, unsafe, a string) refuses the head, whatever the
// other runs say; the policy-clear writer keeps that refusal and posts nothing.
describe('unordered red-team check-run ids are refused', () => {
  beforeAll(async () => { api = await import('../red-team-check-run.mjs'); });
  const run = (over = {}) => ({ id: 10, name: 'red-team', head_sha: HEAD, external_id: 'o/r#7',
    app: { id: APP_ID }, status: 'completed', conclusion: 'success', ...over });
  const ORDERING = 'red-team check run ordering unreadable; inspect check history';
  const BAD_IDS = [['missing', undefined], ['null', null], ['zero', 0], ['negative', -1], ['fractional', 10.5],
    ['unsafe', Number.MAX_SAFE_INTEGER + 2], ['a numeric string', '11'], ['NaN', Number.NaN]];

  it.each(BAD_IDS)('the gate refuses a head whose matching run id is %s, even beside a valid success', (_label, id) => {
    const bad = run({ id, conclusion: 'success' });
    if (id === undefined) delete bad.id;
    for (const checkRuns of [[run(), bad], [bad, run()], [bad]])
      expect(api.evaluateRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, checkRuns }))
        .toEqual({ ok: false, reason: ORDERING });
  });

  it('a bad id on a run the gate does not read (other app, head, PR or name) does not refuse the head', () => {
    const checkRuns = [run(), run({ id: 'x', app: { id: 1 } }), run({ id: null, head_sha: OLD_HEAD }),
      run({ id: 0, name: 'test' }), run({ id: -1, external_id: 'o/r#8' }), run({ id: 10, external_id: 'o/r#8' })];
    expect(api.evaluateRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, checkRuns }).ok).toBe(true);
  });

  it.each([false, true])('two matching runs sharing one id are unordered: the head is refused in either order (reverse=%s)', reverse => {
    const checkRuns = [run({ conclusion: 'failure' }), run()];
    if (reverse) checkRuns.reverse();
    expect(api.evaluateRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, checkRuns }))
      .toEqual({ ok: false, reason: ORDERING });
    const gh = vi.fn(args => {
      if (args.includes('POST')) throw Error('must not post');
      return JSON.stringify({ total_count: 2, check_runs: checkRuns });
    });
    expect(api.publishRedTeamPolicyClearCheck({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, gh }))
      .toEqual({ ok: false, reason: `policy-clear check not posted: ${ORDERING}` });
    expect(api.readRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, gh }))
      .toEqual({ ok: false, reason: ORDERING });
  });

  it.each(BAD_IDS)('the policy-clear writer keeps the refusal for an id that is %s and posts nothing', (_label, id) => {
    const bad = run({ id, status: 'in_progress', conclusion: null });
    if (id === undefined) delete bad.id;
    const gh = vi.fn(args => {
      if (args.includes('POST')) throw Error('must not post');
      return JSON.stringify({ total_count: 2, check_runs: [run(), bad] });
    });
    expect(api.publishRedTeamPolicyClearCheck({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, gh }))
      .toEqual({ ok: false, reason: `policy-clear check not posted: ${ORDERING}` });
    expect(gh.mock.calls.some(([args]) => args.includes('POST'))).toBe(false);
  });

  it('the bounded gate read keeps the refusal', () => {
    const gh = vi.fn(() => JSON.stringify({ total_count: 2, check_runs: [run(), run({ id: -3 })] }));
    expect(api.readRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, gh }))
      .toEqual({ ok: false, reason: ORDERING });
  });
});


function sealed(status, fn) {
  const root = mkdtempSync(join(tmpdir(), 'result-check-recovery-'));
  const env = { WE_SHARED_RUNS_DIR: join(root, 'runs') };
  const path = sealedStatusPath({ repo: 'o/r', pr: 7, head: HEAD }, env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ repo: 'o/r', pr: 7, head: HEAD, status: 'finished', result: 'ran', ...status }));
  try { fn(env); } finally { rmSync(root, { recursive: true, force: true }); }
}

describe('sealed result check recovery writer', () => {
  it.each(['confirmed break', 'publication pending', 'unreadable sealed evidence'])(
    'never publishes success for %s', hold => sealed({ sealedBreaks: [] }, env => {
      const gh = vi.fn(() => JSON.stringify({ total_count: 0, check_runs: [] }));
      const comments = [{ body: `${redTeamMarker(7, HEAD)}\nRed team not required on this head: clear`, author: { login: 'web-everything' } }];
      const readResultHold = vi.fn(() => hold);
      const result = api.publishRedTeamPolicyClearCheck({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID,
        gh, resultComments: comments, readResultHold, env });
      expect(result.ok).toBe(false);
      expect(gh.mock.calls.some(([args]) => args.includes('POST'))).toBe(false);
    }));
});


describe('result recovery uses the drain sealed disposition and trusted check identity', () => {
  const comments = () => [{ body: `${redTeamMarker(7, HEAD)}\nRed team not required on this head: clear`, author: { login: 'web-everything' } }];
  function fake(initial = [], { onPost = () => {}, onRead = () => {}, liveHead = HEAD } = {}) {
    const runs = [...initial], posts = [];
    const gh = vi.fn((args, options) => {
      if (args.includes('POST')) {
        const payload = JSON.parse(options.input);
        onPost(runs, posts);
        posts.push(payload);
        runs.push({ ...payload, id: 100 + posts.length, app: { id: APP_ID } });
        return '{}';
      }
      if (args.includes('--paginate')) return `${comments()[0].body.replaceAll('\n', '\\n')}\t\tweb-everything\tIC_result\t\n`;
      if (args[1] === 'graphql') return JSON.stringify({ data: { repository: { pullRequest: { comments: { totalCount: 1 } } } } });
      if (args[0] === 'pr') return JSON.stringify({ headRefOid: liveHead });
      onRead(runs);
      return JSON.stringify({ total_count: runs.length, check_runs: runs });
    });
    return { gh, posts, runs };
  }
  it('refuses a trusted break comment appearing after the result snapshot before POST', () => sealed({ sealedBreaks: [] }, env => {
    const f = fake();
    const snapshot = comments();
    const fresh = [...snapshot, { author: { login: 'web-everything' },
      body: `${redTeamMarker(7, HEAD)}\n1. [**confirmed**] (edge-case, broken) — Late break` }];
    const readComments = vi.fn(() => fresh);
    expect(api.publishRedTeamPolicyClearCheck({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID,
      resultComments: snapshot, gh: f.gh, env, readComments })).toMatchObject({ ok: false,
      reason: expect.stringContaining('confirmed a break') });
    expect(readComments).toHaveBeenCalledOnce();
    expect(f.posts).toEqual([]);
  }));
  it.each(['throws', 'missing', 'result removed'])(
    'refuses unreadable or missing fresh result comments before POST: %s', mode => sealed({ sealedBreaks: [] }, env => {
      const f = fake();
      const readComments = () => { if (mode === 'throws') throw Error('comments unavailable'); return mode === 'missing' ? undefined : []; };
      expect(api.publishRedTeamPolicyClearCheck({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID,
        resultComments: comments(), gh: f.gh, env, readComments }).ok).toBe(false);
      expect(f.posts).toEqual([]);
    }));
  it('disables read memo for the final live head and check-fact reads before POST', () => sealed({ sealedBreaks: [] }, env => {
    vi.stubEnv('WE_GH_READ_MEMO_DIR', join(env.WE_SHARED_RUNS_DIR, 'memo'));
    try {
      const f = fake();
      const readComments = vi.fn(() => comments());
      expect(api.publishRedTeamPolicyClearCheck({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID,
        resultComments: comments(), gh: f.gh, env: { ...env, WE_GH_READ_MEMO_DIR: process.env.WE_GH_READ_MEMO_DIR },
        readComments }).ok).toBe(true);
      const postIndex = f.gh.mock.calls.findIndex(([args]) => args.includes('POST'));
      const reads = f.gh.mock.calls.slice(0, postIndex);
      expect(reads).toHaveLength(4);
      expect(reads.slice(0, 2).every(([, opts]) => opts.throttle === undefined)).toBe(true);
      for (const [, opts] of reads.slice(2)) {
        expect(opts.throttle.env.WE_GH_READ_MEMO_DIR).toBe('');
        expect(opts.env.WE_GH_READ_MEMO_DIR).toBe('');
      }
      expect(process.env.WE_GH_READ_MEMO_DIR).toBeTruthy();
    } finally { vi.unstubAllEnvs(); }
  }));
  it.each(['clear', 'held', 'unreadable'])('disables read memo for post-write recovery verification and correction: %s', mode => sealed({ sealedBreaks: [] }, env => {
    vi.stubEnv('WE_GH_READ_MEMO_DIR', join(env.WE_SHARED_RUNS_DIR, 'memo'));
    try {
      const f = fake([], { onPost(runs, posts) {
        if (mode === 'held' && !posts.length) runs.push({ id: 100, name: 'red-team', head_sha: HEAD,
          external_id: 'o/r#7', app: { id: APP_ID }, status: 'in_progress' });
      }, onRead() {
        if (mode === 'unreadable' && f.posts.length) throw Error('verification unavailable');
      } });
      const result = api.publishRedTeamPolicyClearCheck({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID,
        resultComments: comments(), gh: f.gh, env: { ...env, WE_GH_READ_MEMO_DIR: process.env.WE_GH_READ_MEMO_DIR },
        readComments: () => comments() });
      const postIndex = f.gh.mock.calls.findIndex(([args]) => args.includes('POST'));
      const reads = f.gh.mock.calls.slice(postIndex + 1).filter(([args]) => !args.includes('POST'));
      expect(reads).toHaveLength(1);
      for (const [, opts] of reads) {
        expect(opts.env.WE_GH_READ_MEMO_DIR).toBe('');
        expect(opts.throttle.env.WE_GH_READ_MEMO_DIR).toBe('');
      }
      expect(result.ok).toBe(mode === 'clear');
      expect(f.posts).toHaveLength(mode === 'clear' ? 1 : 2);
      if (mode !== 'clear') expect(f.posts.at(-1)).toMatchObject({ status: 'in_progress' });
      expect(process.env.WE_GH_READ_MEMO_DIR).toBeTruthy();
    } finally { vi.unstubAllEnvs(); }
  }));
  it('publishes a finished sealed clear once and skips its existing trusted run on retry', () => {
    sealed({ status: 'finished', sealedBreaks: [] }, env => {
      const f = fake();
      const args = { repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, resultComments: comments(), gh: f.gh, env };
      expect(api.publishRedTeamPolicyClearCheck(args).ok).toBe(true);
      expect(api.publishRedTeamPolicyClearCheck(args).ok).toBe(true);
      expect(f.posts).toHaveLength(1);
      expect(f.posts[0]).toMatchObject({ head_sha: HEAD, external_id: 'o/r#7', conclusion: 'success' });
    });
  });
  it.each(['missing', 'unreadable', 'another head'])(
    'refuses a trusted comment with %s persisted status', mode => {
      sealed({ sealedBreaks: [] }, env => {
        const path = sealedStatusPath({ repo: 'o/r', pr: 7, head: HEAD }, env);
        if (mode === 'missing') rmSync(path);
        else writeFileSync(path, mode === 'unreadable' ? '{' : JSON.stringify({
          repo: 'o/r', pr: 7, head: OLD_HEAD, sealedBreaks: [] }));
        const f = fake();
        expect(api.publishRedTeamPolicyClearCheck({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID,
          resultComments: comments(), gh: f.gh, env })).toMatchObject({ ok: false,
          reason: expect.stringContaining('stored result status missing or unreadable for this head') });
        expect(f.posts).toEqual([]);
      });
    });
  it.each(['running', 'queued', undefined, 'unknown'])(
    'refuses an unfinished stored status (%s) even with a clear seal', status => {
      sealed({ status, sealedBreaks: [] }, env => {
        const f = fake();
        const readResultHold = vi.fn(() => null);
        expect(api.publishRedTeamPolicyClearCheck({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID,
          resultComments: comments(), gh: f.gh, env, readResultHold })).toMatchObject({ ok: false,
          reason: expect.stringContaining('not finished for this head; wait for the pass to finish and retry publication') });
        expect(f.posts).toEqual([]);
        expect(readResultHold).not.toHaveBeenCalled();
      });
    });
  it.each([false, true])('returns failure when recovery verification crashes (corrective post fails=%s)', failCorrection => {
    sealed({ sealedBreaks: [] }, env => {
      const f = fake([], {
        onRead() { if (f.posts.length) throw Error('verification crashed'); },
        onPost() { if (failCorrection && f.posts.length) throw Error('corrective post failed'); },
      });
      expect(api.publishRedTeamPolicyClearCheck({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID,
        resultComments: comments(), gh: f.gh, env })).toMatchObject({ ok: false,
        detail: expect.stringContaining(failCorrection ? 'superseding in_progress not posted' : 're-read after publication failed') });
      expect(f.posts).toHaveLength(failCorrection ? 1 : 2);
    });
  });
  it.each([{ sealedBreaks: ['unpublished-break'] }, {}, { sealedBreaks: 'corrupt' }])(
    'refuses held, unsealed and unreadable stored results: %j', status => {
      sealed(status, env => {
        const f = fake();
        expect(api.publishRedTeamPolicyClearCheck({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID,
          resultComments: comments(), gh: f.gh, env }).ok).toBe(false);
        expect(f.posts).toEqual([]);
      });
    });
  it.each(['in_progress', 'failure'])('never supersedes an existing %s run', state => {
    const f = fake([{ id: 10, name: 'red-team', head_sha: HEAD, external_id: 'o/r#7', app: { id: APP_ID },
      status: state === 'in_progress' ? state : 'completed', conclusion: state === 'failure' ? state : null }]);
    expect(api.publishRedTeamPolicyClearCheck({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID,
      resultComments: comments(), gh: f.gh }).ok).toBe(false);
    expect(f.posts).toEqual([]);
  });
  it.each(['in_progress', 'failure'].flatMap(state => [false, true].map(policyClear => [state, policyClear])))(
    'corrects a concurrent %s run appearing between the final read and POST (policy-clear=%s)', (state, policyClear) => sealed({ sealedBreaks: [] }, env => {
    const f = fake([], { onPost(runs, posts) {
      if (!posts.length) runs.push({ id: 100, name: 'red-team', head_sha: HEAD, external_id: 'o/r#7',
        app: { id: APP_ID }, status: state === 'failure' ? 'completed' : state,
        conclusion: state === 'failure' ? state : null, output: { title: `${policyClear ? 'Policy-clear: ' : ''}Red team held` } });
    } });
    const result = api.publishRedTeamPolicyClearCheck({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID,
      resultComments: comments(), gh: f.gh, env, readResultHold: () => null });
    expect(result).toMatchObject({ ok: false, reason: api.POLICY_CLEAR_YIELDED });
    expect(f.posts).toHaveLength(2);
    expect(f.runs.at(-1)).toMatchObject({ status: state === 'failure' ? 'completed' : state });
    expect(f.runs.at(-1).conclusion).not.toBe('success');
  }));
  it('refuses a held run appearing in the final check-fact read before POST', () => sealed({ sealedBreaks: [] }, env => {
    let reads = 0;
    const f = fake([], { onRead(runs) {
      if (++reads === 3) runs.push({ id: 100, name: 'red-team', head_sha: HEAD, external_id: 'o/r#7',
        app: { id: APP_ID }, status: 'in_progress' });
    } });
    expect(api.publishRedTeamPolicyClearCheck({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID,
      resultComments: comments(), gh: f.gh, env, readResultHold: () => null }).ok).toBe(false);
    expect(f.posts).toEqual([]);
  }));
  it.each([{ sealedBreaks: ['late break'] }, {},
    { status: 'running', sealedBreaks: [] }, { status: 'queued', sealedBreaks: [] }])(
    'rechecks a disposition that becomes held before POST: %j', status => {
    sealed({ sealedBreaks: [] }, env => {
      let reads = 0;
      const f = fake([], { onRead() {
        if (++reads === 2) writeFileSync(sealedStatusPath({ repo: 'o/r', pr: 7, head: HEAD }, env),
          JSON.stringify({ repo: 'o/r', pr: 7, head: HEAD, status: 'finished', result: 'ran', ...status }));
      } });
      expect(api.publishRedTeamPolicyClearCheck({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID,
        resultComments: comments(), gh: f.gh, env }).ok).toBe(false);
      expect(f.posts).toEqual([]);
    });
  });
  it.each([HEAD, OLD_HEAD, undefined])('rechecks the live head with real result comments (head=%s)', liveHead => sealed({ sealedBreaks: [] }, env => {
    const f = fake([], { liveHead });
    // Explicit undefined models an unreadable head, rather than the fake's default.
    if (liveHead === undefined) f.gh.mockImplementation(args => args[0] === 'pr' ? '{}' : JSON.stringify({ total_count: 0, check_runs: [] }));
    expect(api.publishRedTeamPolicyClearCheck({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID,
      resultComments: comments(), gh: f.gh, env, readResultHold: () => null }).ok).toBe(liveHead === HEAD);
    expect(f.posts).toHaveLength(liveHead === HEAD ? 1 : 0);
  }));
  it('refuses an oversized check history with an operator fallback', () => {
    const gh = vi.fn(() => JSON.stringify({ total_count: 101, check_runs: Array(101).fill({}) }));
    expect(api.publishRedTeamPolicyClearCheck({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID,
      resultComments: comments(), gh })).toMatchObject({ ok: false, reason: expect.stringContaining('operator must inspect full check history') });
    expect(gh).toHaveBeenCalledTimes(1);
  });
  it.each([{ resultComments: [] }, { resultComments: [{ body: 'not a result', author: { login: 'web-everything' } }] },
    { resultComments: [{ body: `${redTeamMarker(7, HEAD)}\nRed team clear`, author: { login: 'untrusted-user' } }] }])(
    'requires a trusted head-bound result: %j', ({ resultComments }) => {
    const f = fake();
    expect(api.publishRedTeamPolicyClearCheck({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID,
      resultComments, gh: f.gh }).ok).toBe(false);
    expect(f.gh).not.toHaveBeenCalled();
  });
});


it('result recovery refuses a run that appears between its absence read and the guarded writer read', () => sealed({ sealedBreaks: [] }, env => {
  let reads = 0;
  const gh = vi.fn(() => {
    reads++;
    const runs = reads === 1 ? [] : [{ id: 10, name: 'red-team', head_sha: HEAD, external_id: 'o/r#7',
      app: { id: APP_ID }, status: 'in_progress', output: { title: 'Policy-clear: Red team in progress' } }];
    return JSON.stringify({ total_count: runs.length, check_runs: runs });
  });
  expect(api.publishRedTeamPolicyClearCheck({ repo: 'o/r', pr: 7, headSha: HEAD, appId: APP_ID, gh,
    resultComments: [{ body: `${redTeamMarker(7, HEAD)}\nRed team not required on this head: clear`, author: { login: 'web-everything' } }],
    env, readResultHold: () => null }).ok).toBe(false);
  expect(gh).toHaveBeenCalledTimes(2);
}));
