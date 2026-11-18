import { describe, it, expect } from 'vitest';
import { acceptJurorStream, JudgeBudgetError, JudgeTimeoutError, judgeSpawn } from '../judge-spawn.mjs';

const sessionId = 'aaaaaaaa-bbbb-8ccc-9ddd-eeeeeeeeeeee';
const schema = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'], additionalProperties: false };
const ok = { type: 'result', subtype: 'success', session_id: sessionId, structured_output: { verdict: 'accept' } };
const quota = { type: 'error', message: "You've hit your weekly limit · resets tomorrow" };
const budget = { type: 'result', subtype: 'error_max_budget_usd', total_cost_usd: 1 };
const generic = { type: 'error', message: 'execution failed' };
const lines = (...events) => events.map(event => typeof event === 'string' ? event : JSON.stringify(event)).join('\n');
const exit = { code: 0, signal: null, timedOut: false, budget: 0.5, now: 1234 };
const run = (stream, options = {}) => acceptJurorStream(stream, { sessionId, schema, exit, ...options });

const probes = [
  ['numeric verdict', lines({ ...ok, structured_output: { verdict: 123 } }), {}, /schema violation/],
  ...['$async', 'format', 'unevaluatedProperties'].map(keyword => [keyword, lines(ok),
    { schema: { ...schema, [keyword]: keyword === 'format' ? 'uri' : true } }, /schema compilation failed/]),
  ['empty output vs required verdict', lines({ ...ok, structured_output: {} }), {}, /required/],
  ...[true, 'true'].map(is_error => [`is_error ${JSON.stringify(is_error)}`, lines({ ...ok, is_error }), {}, /failed/]),
  ['error_during_execution', lines({ ...ok, subtype: 'error_during_execution' }), {}, /unsuccessful/],
  ['earlier error', lines(generic, ok), {}, /JSON error event/],
  ['trailing error', lines(ok, generic), {}, /JSON error event/],
  ['error result then success', lines({ ...ok, is_error: true }, ok), {}, /failed/],
  ['blocking rejection then acceptance', lines({ ...ok, structured_output: { verdict: 'reject' } }, ok), {}, /exactly one/],
  ['schema-invalid then valid', lines({ ...ok, structured_output: { verdict: 123 } }, ok), {}, /exactly one/],
  ['another UUID', lines({ ...ok, session_id: 'bbbbbbbb-bbbb-8ccc-9ddd-eeeeeeeeeeee' }), {}, /session_id mismatch/],
  ['malformed then success', lines('{broken', ok), {}, /malformed JSON/],
  ['truncated error then success', lines('{"type":"error","message":"SECRET_TOKEN', ok), {}, /malformed JSON/],
  ['8MiB with earlier failure', lines(generic, 'x'.repeat(8 * 1024 * 1024), ok), {}, /exceeds 8MiB.*inspect the full run manually/],
  ['8MiB with earlier quota', lines(quota, 'x'.repeat(8 * 1024 * 1024), ok), {}, /weekly limit/],
  ['nonzero exit', '', { exit: { ...exit, code: 1 } }, /process failed/],
  ['exit 1 with valid verdict', lines(ok), { exit: { ...exit, code: 1 } }, /process failed/],
  ['SIGTERM empty', '', { exit: { ...exit, code: null, signal: 'SIGTERM' } }, JudgeTimeoutError],
  ['null code', lines(ok), { exit: { ...exit, code: null } }, JudgeTimeoutError],
  ['timeout valid verdict', lines(ok), { exit: { ...exit, timedOut: true } }, JudgeTimeoutError],
  ['budget then quota', lines(budget, quota), {}, /weekly limit/],
  ['quota then budget', lines(quota, budget), {}, /weekly limit/],
  ['generic then budget', lines(generic, budget), {}, JudgeBudgetError],
  ['budget outranks timeout', lines(budget), { exit: { ...exit, timedOut: true } }, JudgeBudgetError],
  ['quota without is_error', lines(quota), {}, /weekly limit/],
  ['trailing meaningful event', lines(ok, { type: 'assistant' }), {}, /last meaningful/],
  ['trailing system error', lines(ok, { type: 'system', error: 'failure' }), {}, /JSON error event/],
  ['unattributed JSON', '{}', {}, /exactly one/],
];

describe('acceptJurorStream audit probes', () => {
  it.each(probes)('fails closed: %s', (_name, stream, options, expected) => {
    expect(() => run(stream, options)).toThrow(expected);
  });
  it.each([
    ['JSON document', JSON.stringify(ok, null, 2)],
    ['JSON lines with benign trailers', lines({ type: 'system' }, ok, { type: 'system' }, { type: 'rate_limit_event' })],
    ['legacy document', lines({ session_id: sessionId, structured_output: ok.structured_output })],
    ['legacy without session', lines({ structured_output: ok.structured_output })],
    ['plain log ignored', lines('plain log', ok)],
  ])('accepts %s', (_name, stream) => expect(run(stream).value).toEqual(ok.structured_output));
  it('keeps quota hold metadata deterministically', () => {
    let error;
    try { run(lines(budget, quota)); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ quota: true, holdRow: { provider: 'claude', status: 'quota-exhausted',
      scoredAt: new Date(exit.now).toISOString() }, telemetry: { failureKind: 'provider-quota' } });
  });
  it.each([
    lines('{"type":"error","message":"SECRET_TOKEN', ok),
    lines({ ...ok, structured_output: { verdict: 123, SECRET_TOKEN: true } }),
    lines({ ...ok, is_error: true, structured_output: { SECRET_TOKEN: true } }),
  ])('redacts malformed and schema evidence', stream => {
    let error;
    try { run(stream); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain('SECRET_TOKEN');
  });
  it('only empty or plain stdout at exit zero is retryable', () => {
    for (const stream of ['', 'plain text']) {
      let error;
      try { run(stream); } catch (caught) { error = caught; }
      expect(error).toMatchObject({ unparseableStdout: true });
      expect(error.verdictIntegrity).not.toBe(true);
    }
  });
  it('empty stdout exit zero retries with a fresh session', async () => {
    let calls = 0;
    const spawnFn = (_cli, argv) => {
      const attempt = ++calls;
      const stdout = attempt === 1 ? '' : lines({ ...ok, session_id: argv[argv.indexOf('--session-id') + 1] });
      return { stdin: { on() {}, end() {} }, stdout: { on(event, cb) { if (event === 'data') cb(stdout); } },
        stderr: { on() {} }, on(event, cb) { if (event === 'close') queueMicrotask(() => cb(0, null)); } };
    };
    const result = await judgeSpawn({ mandate: 'm', input: 'i', sessionId, shape: schema, retries: 1, log() {}, spawnFn });
    expect(result.attempts).toBe(2);
    expect(calls).toBe(2);
  });
});
