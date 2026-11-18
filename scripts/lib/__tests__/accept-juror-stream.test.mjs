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
  ['missing session_id', lines({ type: 'result', structured_output: ok.structured_output }), {}, /session_id missing/],
  ['legacy without session', lines({ structured_output: ok.structured_output }), {}, /session_id missing/],
  ...['[]', '[{"type":"error"}', '"log"', '123', 'true', 'null', 'plain log'].flatMap(line =>
    ['before', 'after'].map(position => [`${line} ${position} success`, position === 'before' ? lines(line, ok) : lines(ok, line), {}, /malformed JSON|invalid JSON event/])),
  ...['[]', '"log"', '123', 'true', 'null', '[{"type":"error"}'].map(line =>
    [`non-object or truncated document ${line}`, line, {}, /malformed JSON|invalid JSON event/]),
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
  it.each([
    ['quota alone', lines(quota), exit, []],
    ['quota with trailing whitespace', lines({ ...quota, message: `${quota.message} \n\t` }), exit, []],
    ['quota with dated reset', lines({ ...quota, message: "You've hit your weekly limit · resets Oct 30 at 4pm (America/Toronto)" }), exit, []],
    ['quota followed by execution text in one message', lines({ ...quota, message: `${quota.message}; execution failed` }), exit, ['execution-error']],
    ['quota followed by execution text on a new line', lines({ ...quota, message: `${quota.message}\nexecution failed` }), exit, ['execution-error']],
    ['quota with unknown reset shape', lines({ ...quota, message: "You've hit your weekly limit · resets unknown" }), exit, ['execution-error']],
    ...['error', 'errors', 'result', 'stderr', 'details'].flatMap(key =>
      [[], {}, null, '', false, 0].map(value => [`quota with present ${key}: ${JSON.stringify(value)}`,
        lines({ ...quota, [key]: value }), exit, ['execution-error']])),
    ['quota result with empty extra message', lines({ type: 'result', is_error: true, result: quota.message, message: '' }), exit, ['execution-error']],
    ['two quota events', lines(quota, quota), exit, ['execution-error']],
    ['quota with valid verdict', lines(quota, ok), exit, ['execution-error']],
    ['quota with other JSON diagnostic', lines(quota, { type: 'system', message: 'execution failed' }), exit, ['execution-error']],
    ['quota message and execution error in the same event', lines({ ...quota, error: 'execution failed' }), exit, ['execution-error']],
    ...[
      ['message', { type: 'error', result: quota.message, message: 'execution failed' }],
      ['result', { ...quota, result: 'execution failed' }],
      ['subtype', { ...quota, subtype: 'error_during_execution' }],
      ['code', { ...quota, code: 'execution_failed' }],
      ['nested error message', { ...quota, error: { message: 'execution failed' } }],
      ['nested error code', { ...quota, error: { message: quota.message, code: 'execution_failed' } }],
      ['stderr', { ...quota, stderr: 'execution failed SECRET_TOKEN' }],
      ['unknown error object', { ...quota, error: {} }],
      ['numeric code', { ...quota, code: 1 }],
    ].map(([field, event]) => [`quota and non-quota ${field} in the same event`, lines(event), exit, ['execution-error']]),
    ['quota in every diagnostic field', lines({ ...quota, error: { message: quota.message }, result: quota.message }), exit, ['execution-error']],
    ['quota is_error result alone', lines({ type: 'result', is_error: true, result: quota.message }), exit, []],
    ['quota is_error result and execution event', lines({ type: 'result', is_error: true, result: quota.message }, generic), exit, ['execution-error']],
    ['quota and process stderr execution error', lines(quota), { ...exit, stderr: 'execution failed SECRET_TOKEN' }, ['execution-error']],
    ['quota and process stderr quota', lines(quota), { ...exit, stderr: quota.message }, ['execution-error']],
    ['execution error then quota', lines(generic, quota), exit, ['execution-error']],
    ['quota then execution error', lines(quota, generic), exit, ['execution-error']],
    ['quota and nonzero exit', lines(quota), { ...exit, code: 1 }, ['process-failure']],
    ['quota and timeout', lines(quota), { ...exit, timedOut: true }, ['timeout']],
    ['quota and signal', lines(quota), { ...exit, signal: 'SIGTERM' }, ['timeout']],
    ['quota and unknown exit', lines(quota), { ...exit, code: null }, ['timeout']],
    ['quota and malformed line', lines(quota, '{SECRET_TOKEN'), exit, ['malformed-output']],
    ['quota and invalid event', lines(quota, 'null'), exit, ['invalid-event']],
    ['quota and budget', lines(quota, budget), exit, ['budget']],
    ['quota and invalid successful result', lines(quota, { ...ok, structured_output: {} }), exit, ['schema-violation']],
    ['quota and mismatched session', lines(quota, { ...ok, session_id: 'wrong' }), exit, ['session-mismatch']],
  ])('retains quota precedence and counts concurrent failures: %s', (_name, stream, processExit, kinds) => {
    let error;
    try { run(stream, { exit: processExit }); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ quota: true, holdRow: { provider: 'claude', status: 'quota-exhausted' },
      telemetry: { failureKind: kinds.length ? 'mixed-failure' : 'provider-quota', quotaOnly: kinds.length === 0 } });
    expect(error.message).toContain('weekly limit');
    expect(error.telemetry.otherFailures.map(row => row.kind)).toEqual(kinds);
    for (const row of error.telemetry.otherFailures) {
      expect(row).toMatchObject({ message: expect.any(String), redacted: true });
      expect(row.message.length).toBeLessThanOrEqual(200);
    }
    expect(JSON.stringify(error.telemetry.otherFailures)).not.toContain('SECRET_TOKEN');
  });
  it('bounds concurrent failure telemetry and requires manual inspection of omitted evidence', () => {
    let error;
    try { run(lines(quota, ...Array(25).fill(generic))); } catch (caught) { error = caught; }
    expect(error.telemetry).toMatchObject({ quotaOnly: false, failureKind: 'mixed-failure', otherFailuresOmitted: 5 });
    expect(error.telemetry.otherFailures).toHaveLength(20);
    expect(error.telemetry.otherFailuresNote).toContain('inspect the full run manually');
  });
  it.each(probes)('fails closed: %s', (_name, stream, options, expected) => {
    expect(() => run(stream, options)).toThrow(expected);
    if (expected instanceof RegExp && /malformed JSON|invalid JSON event|session_id/.test(expected.source)) {
      try { run(stream, options); } catch (error) {
        expect(error.verdictIntegrity).toBe(true);
      }
    }
  });
  it.each([
    ['JSON document', JSON.stringify(ok, null, 2)],
    ['JSON lines with benign trailers', lines({ type: 'system' }, ok, { type: 'system' }, { type: 'rate_limit_event' })],
    ['legacy document', lines({ session_id: sessionId, structured_output: ok.structured_output })],
    ['blank lines ignored', `\n \n${lines(ok)}\n\t\n`],
  ])('accepts %s', (_name, stream) => expect(run(stream).value).toEqual(ok.structured_output));
  it('keeps quota hold metadata deterministically', () => {
    let error;
    try { run(lines(budget, quota)); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ quota: true, holdRow: { provider: 'claude', status: 'quota-exhausted',
      scoredAt: new Date(exit.now).toISOString() }, telemetry: { failureKind: 'mixed-failure', quotaOnly: false,
        otherFailures: [{ kind: 'budget', message: expect.any(String), redacted: true }] } });
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
