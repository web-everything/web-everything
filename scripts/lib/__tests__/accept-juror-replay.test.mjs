import real1 from './fixtures/juror-real1.json';
import real2 from './fixtures/juror-real2.json';
import { describe, expect, it } from 'vitest';
import { acceptJurorStream, JUROR_RESULT_KEYS, JUROR_FATAL_STDERR } from '../judge-spawn.mjs';

// Real CLI captures; only session_id, uuid and credential_expires_at were replaced.
const captures = [real1, real2];
const sessionId = captures[0].session_id;
const schema = { type: 'object', properties: { verdict: { enum: ['accept', 'reject'] } },
  required: ['verdict'], additionalProperties: false };
const exit = { code: 0, signal: null, timedOut: false };
const run = (result, stderr = '') => acceptJurorStream(JSON.stringify(result), {
  sessionId, schema, exit: { ...exit, stderr },
});
const quotaText = "You've hit your weekly limit · resets tomorrow";

describe('captured juror result replay', () => {
  it('accepts system/init and assistant events carrying session_id before a successful result', () => {
    const stream = [
      { type: 'system', subtype: 'init', session_id: sessionId, tools: [], model: 'claude-opus-5-5' },
      { type: 'assistant', session_id: sessionId,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Review complete.' }] } },
      captures[0],
    ].map(event => JSON.stringify(event)).join('\n');
    expect(acceptJurorStream(stream, { sessionId, schema, exit }).value).toEqual({ verdict: 'accept' });
  });
  it.each(captures)('accepts the real successful capture with duration $duration_ms', capture => {
    expect(Object.keys(capture).sort()).toEqual([...JUROR_RESULT_KEYS].sort());
    expect(run(capture).value).toEqual({ verdict: 'accept' });
  });
  it.each([
    ['unknown extra key', { future_cli_field: true }, /unknown result key/],
    ['errors array', { errors: ['x'] }, /unknown result key/],
    ['empty errors', { errors: [] }, /unknown result key/],
    ['null error', { error: null }, /unknown result key/],
    ['API error status', { api_error_status: 429 }, /unsuccessful result envelope/],
    ['permission denial', { permission_denials: [{}] }, /unsuccessful result envelope/],
    ['malformed permission denials', { permission_denials: null }, /unsuccessful result envelope/],
    ['null is_error', { is_error: null }, /unsuccessful result envelope/],
    ['numeric is_error', { is_error: 0 }, /unsuccessful result envelope/],
    ['wrong session', { session_id: 'wrong' }, /session_id mismatch/],
    ['schema violation', { structured_output: { verdict: 'maybe' } }, /schema violation/],
  ])('fails closed on %s with terminal evidence', (_name, patch, message) => {
    let error;
    try { run({ ...captures[0], ...patch }); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ verdictIntegrity: true, unparseableStdout: true });
    expect(error.message).toMatch(message);
  });
  it.each(['Fatal: review execution failed', 'Error: review failed', 'Traceback (most recent call last)',
    'Unhandled rejection', 'Unhandled exception', 'panic: runtime failed'])('rejects fatal stderr: %s', stderr => {
    expect(JUROR_FATAL_STDERR.some(pattern => pattern.test(stderr))).toBe(true);
    expect(() => run(captures[0], `warning: startup\n${stderr}`)).toThrow(/fatal\/error diagnostic/);
  });
  it.each(['warning: deprecated', 'ordinary CLI diagnostic'])('accepts nonfatal stderr: %s', stderr => {
    expect(run(captures[0], stderr).value).toEqual({ verdict: 'accept' });
  });
  it.each([
    ['wrong session', { session_id: 'wrong' }, 'session-mismatch'],
    ['invalid schema', { structured_output: { verdict: 'maybe' } }, 'schema-violation'],
    ['contradictory verdict', {}, 'result-envelope'],
    ['unknown key', { future_cli_field: true }, 'result-keys'],
  ])('quota result with %s remains countable', (_name, patch, kind) => {
    let error;
    try { run({ ...captures[0], is_error: true, result: quotaText, ...patch }); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ quota: true, telemetry: { quotaOnly: false, failureKind: 'mixed-failure' } });
    expect(error.telemetry.otherFailures).toEqual(expect.arrayContaining([expect.objectContaining({ kind })]));
  });
  it.each([
    { session_id: 'wrong' },
    { structured_output: { verdict: 'accept' } },
    { session_id: 'wrong', structured_output: { verdict: 'accept' } },
  ])('does not exempt an error envelope carrying result evidence: %j', evidence => {
    let error;
    try { run({ type: 'error', message: quotaText, ...evidence }); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ quota: true, telemetry: { quotaOnly: false } });
  });
  it('retains legacy quota error events with warnings and rejects fatal stderr', () => {
    const event = { type: 'error', message: quotaText };
    for (const [stderr, quotaOnly] of [['warning: deprecated', true], ['Fatal: review execution failed', false]]) {
      let error;
      try { run(event, stderr); } catch (caught) { error = caught; }
      expect(error.telemetry).toMatchObject({ quotaOnly });
    }
  });
});
