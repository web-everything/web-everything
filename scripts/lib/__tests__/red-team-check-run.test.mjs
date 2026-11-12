// @vitest-environment node
import { describe, it, expect, vi, beforeAll } from 'vitest';
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

  // #6535 round 11 (red-team confirmed break): CI sets WE_APP_ID; every daemon sets WE_GITHUB_APP_ID (the App it mints
  // tokens for, so its posted runs carry that id). One resolver serves every reader.
  it.each([
    ['CI only', { WE_APP_ID: '5037855' }, '5037855'],
    ['daemon only', { WE_GITHUB_APP_ID: '5037855' }, '5037855'],
    ['both equal', { WE_APP_ID: '5037855', WE_GITHUB_APP_ID: ' 5037855 ' }, '5037855'],
    ['an empty CI value falls back to the daemon value', { WE_APP_ID: '', WE_GITHUB_APP_ID: '5037855' }, '5037855'],
    ['neither', {}, undefined],
  ])('resolveRedTeamAppId: %s', (_name, env, expected) => {
    expect(api.resolveRedTeamAppId(env)).toBe(expected);
  });
  it('resolveRedTeamAppId fails closed when the two App ids differ, naming both, before reading GitHub', () => {
    const appId = api.resolveRedTeamAppId({ WE_APP_ID: '5037855', WE_GITHUB_APP_ID: '42' });
    const gh = vi.fn(() => JSON.stringify({ total_count: 1, check_runs: [run()] }));
    for (const fact of [api.evaluateRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, checkRuns: [run()], appId }),
      api.readRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, appId, gh }),
      api.publishRedTeamPolicyClearCheck({ repo: 'o/r', pr: 7, headSha: HEAD, appId, gh })])
      expect(fact).toMatchObject({ ok: false, reason: expect.stringContaining('WE_APP_ID and WE_GITHUB_APP_ID differ') });
    expect(gh).not.toHaveBeenCalled();
  });
  it('the daemon App id alone lets the reader and policy-clear accept a valid success', () => {
    const appId = api.resolveRedTeamAppId({ WE_GITHUB_APP_ID: String(APP_ID) });
    const gh = vi.fn(() => JSON.stringify({ total_count: 1, check_runs: [run()] }));
    expect(api.readRedTeamCheckFact({ repo: 'o/r', pr: 7, headSha: HEAD, appId, gh })).toMatchObject({ ok: true });
    expect(api.publishRedTeamPolicyClearCheck({ repo: 'o/r', pr: 7, headSha: HEAD, appId, gh })).toMatchObject({ ok: true });
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
