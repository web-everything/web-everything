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
