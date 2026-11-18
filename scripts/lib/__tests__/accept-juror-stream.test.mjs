import { describe, expect, it } from 'vitest';
import { acceptJurorStream } from '../accept-juror-stream.mjs';

const message = "You've hit your weekly limit · resets tomorrow";
const event = { type: 'error', message };
const processOutcome = { code: 0, signal: null, timedOut: false };

describe('quota-only whitelist', () => {
  it.each([
    ['pure quota event', event, '', processOutcome, true],
    ['quota with empty error array', { ...event, error: [] }, '', processOutcome, false],
    ['execution error in message', { ...event, message: `${message}\nexecution error: permission denied` }, '', processOutcome, false],
    ['same-line execution error', { ...event, message: `${message}; execution error` }, '', processOutcome, false],
    ['stderr diagnostic', event, 'execution error', processOutcome, false],
    ['nonzero exit', event, '', { ...processOutcome, code: 1 }, false],
    ['signal', event, '', { ...processOutcome, signal: 'SIGTERM' }, false],
    ['killed process reporting zero', event, '', { ...processOutcome, timedOut: true }, false],
    ['unknown process evidence', event, '', {}, false],
    ['unknown reset format', { ...event, message: message.replace('tomorrow', 'whenever') }, '', processOutcome, false],
    ['trailing whitespace', { ...event, message: `${message} \n\t` }, '', processOutcome, true],
    ['known timestamp', { ...event, message: message.replace('tomorrow', 'Oct 30 at 4pm (America/Toronto)') }, '', processOutcome, true],
    ...['error', 'errors', 'result', 'stderr', 'details'].flatMap(key =>
      [[], {}, null, '', false, 0].map(value => [`${key} present as ${JSON.stringify(value)}`, { ...event, [key]: value }, '', processOutcome, false])),
    ...[null, '', [], 'execution_error'].map(subtype => ['other subtype', { ...event, subtype }, '', processOutcome, false]),
    ['extra message beside matched result', { is_error: true, result: message, message: '' }, '', processOutcome, false],
  ])('%s', (_, row, stderr, process, expected) => {
    const evidence = acceptJurorStream(JSON.stringify(row), stderr, process);
    expect(evidence).toMatchObject({ quotaOnly: expected });
    expect(evidence.otherFailures.length === 0).toBe(expected);
  });

  it.each(['execution error', '{}', JSON.stringify(event)])('refuses additional stdout evidence: %s', extra => {
    expect(acceptJurorStream(`${JSON.stringify(event)}\n${extra}`, '', processOutcome))
      .toMatchObject({ quotaOnly: false, otherFailures: expect.arrayContaining(['stream contains additional evidence']) });
  });

  it('does not treat incidental raw quota text as a quota event', () => {
    expect(acceptJurorStream(message, '', processOutcome)).toBeNull();
  });

  it('accepts a lone quota JSON event on stderr', () => {
    expect(acceptJurorStream('', JSON.stringify(event), processOutcome)).toMatchObject({ quotaOnly: true });
  });
});
