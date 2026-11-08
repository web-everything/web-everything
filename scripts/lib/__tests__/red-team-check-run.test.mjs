// @vitest-environment node
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { redTeamEnqueueHold } from '../drain-queue-safety.mjs';

const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);
const APP_ID = 5037855; // WE_APP_ID repository variable
let api;

describe('red-team check run contract', () => {
  beforeAll(async () => { api = await import('../red-team-check-run.mjs'); });
  const run = (over = {}) => ({ id: 10, name: 'red-team', head_sha: HEAD,
    app: { id: APP_ID }, status: 'completed', conclusion: 'success',
    started_at: '2026-11-07T10:00:00Z', ...over });

  it('passes success on the exact head from the configured app', () => {
    expect(api.evaluateRedTeamCheckFact({ headSha: HEAD, checkRuns: [run()], appId: APP_ID })).toMatchObject({ ok: true });
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
    expect(api.evaluateRedTeamCheckFact({ headSha: HEAD, checkRuns, appId: APP_ID }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(reason) });
  });

  it.each([false, true])('uses the latest matching run regardless of input order (reverse=%s)', reverse => {
    const checkRuns = [run(), run({ id: 11, started_at: '2026-11-07T11:00:00Z', conclusion: 'failure' })];
    if (reverse) checkRuns.reverse();
    expect(api.evaluateRedTeamCheckFact({ headSha: HEAD, checkRuns, appId: APP_ID }).ok).toBe(false);
  });

  it('a newer wrong-app or other-head run cannot supersede the matching success', () => {
    expect(api.evaluateRedTeamCheckFact({ headSha: HEAD, appId: APP_ID, checkRuns: [run(),
      run({ id: 11, app: { id: 1 }, conclusion: 'failure' }),
      run({ id: 12, head_sha: OLD_HEAD, conclusion: 'failure' })] }).ok).toBe(true);
  });

  it.each([
    ['finished clear', 'finished', null, false, 'completed', 'success'],
    ['finished held', 'finished', 'post-accept red team has no recorded result on the live head', false, 'completed', 'failure'],
    ['sendBack', 'finished', null, true, 'completed', 'failure'],
    ['pending', 'pending', null, false, 'in_progress', undefined],
    ['running', 'running', null, false, 'in_progress', undefined],
  ])('payload: %s', (_name, status, hold, sendBack, expectedStatus, conclusion) => {
    const payload = api.redTeamCheckRunPayload({ headSha: HEAD, status, hold, result: null, sendBack });
    expect(payload).toMatchObject({ name: 'red-team', head_sha: HEAD, status: expectedStatus,
      output: { title: expect.any(String), summary: expect.any(String) } });
    expect(payload.conclusion).toBe(conclusion);
    if (hold) expect(payload.output.summary).toContain(hold);
  });

  it('a real enqueue hold cannot become success even with a clean result', () => {
    const hold = redTeamEnqueueHold({ scheduled: true, comments: [], pr: 7, head: HEAD, env: {} });
    expect(hold).toEqual(expect.any(String));
    expect(api.redTeamCheckRunPayload({ headSha: HEAD, status: 'finished', hold,
      result: { verdict: 'accept' }, sendBack: false }).conclusion).toBe('failure');
  });

  it('posts the check run to the requested repository using injected gh', async () => {
    const payload = api.redTeamCheckRunPayload({ headSha: HEAD, status: 'finished', hold: null, result: null, sendBack: false });
    const gh = vi.fn(() => JSON.stringify({ id: 123 }));
    expect(await api.postRedTeamCheckRun({ repo: 'o/r', headSha: HEAD, payload, gh })).toMatchObject({ ok: true });
    expect(gh).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(gh.mock.calls)).toContain('repos/o/r/check-runs');
  });

  it('publication errors return a reason without throwing', async () => {
    const gh = vi.fn(() => { throw new Error('permission denied'); });
    expect(await api.postRedTeamCheckRun({ repo: 'o/r', headSha: HEAD,
      payload: { name: 'red-team', head_sha: HEAD, status: 'in_progress' }, gh }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/permission denied/) });
  });

  it('reads check runs from the exact head endpoint with injected gh', async () => {
    const gh = vi.fn(() => JSON.stringify({ total_count: 1, check_runs: [run()] }));
    expect(await api.readRedTeamCheckFact({ repo: 'o/r', headSha: HEAD, appId: APP_ID, gh })).toMatchObject({ ok: true });
    expect(JSON.stringify(gh.mock.calls)).toContain(`repos/o/r/commits/${HEAD}/check-runs`);
  });

  it.each(['API failure', 'malformed JSON', 'missing check_runs'])('reader fails closed: %s', async mode => {
    const gh = vi.fn(() => {
      if (mode === 'API failure') throw new Error('HTTP 403');
      return mode === 'malformed JSON' ? '{' : '{}';
    });
    expect(await api.readRedTeamCheckFact({ repo: 'o/r', headSha: HEAD, appId: APP_ID, gh }))
      .toMatchObject({ ok: false, reason: expect.any(String) });
  });
});
