import { describe, expect, it } from 'vitest';
import { analyzeOrchestratorTurns, CORRECTION_PATTERNS } from '../coroner-orchestrator-analyze.mjs';
import { redact } from '../coroner-transcripts.mjs';

const window = { since: '2026-10-20T12:00:00.000Z', until: '2026-10-20T13:00:00.000Z' };
const at = (n) => new Date(Date.parse(window.since) + n * 60000).toISOString();
const turn = (type, content, n = 1, extra = {}) => ({ type, timestamp: at(n), message: { content }, ...extra });
const assistant = (s, n, extra = {}) => turn('assistant', [{ type: 'text', text: s }], n, extra);
const toolResult = (s, n, id = 'worker') => turn('user', [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: s }] }], n);
const toolCall = (name, id, n = 0) => turn('assistant', [{ type: 'tool_use', name, id, input: {} }], n);
// Redacted reports from the live session; no real transcripts or operator paths are read.
const workerStops = [
  'I stopped before building anything: the brief rests on a wrong premise.',
  "the brief's premise was slightly off.",
  "I didn't build the fix: its premise turned out to be wrong for #5502",
  'The premise was wrong.',
  'The brief rests on a false premise.',
];

describe('orchestrator facts', () => {
  it('detects bounded patterns, ignores injected users and tools, and captures the last assistant text', () => {
    const result = analyzeOrchestratorTurns([
      turn('assistant', [{ type: 'text', text: 'First claim' }, { type: 'text', text: 'Last claim' }]),
      toolResult('Why stop? wrong', 2),
      turn('user', '<system-reminder>Why stop?</system-reminder>', 3),
      turn('user', 'Caveat: wrong command-output', 4),
      turn('user', '<local-command-stdout>wrong</local-command-stdout>', 5),
      turn('user', 'Why? We ruled R12 again?', 6),
      turn('user', 'Careful', 7),
      turn('user', 'stopping wrongly somewhere', 8),
    ], { window });
    expect(result.corrections).toHaveLength(2);
    expect(result.corrections[0]).toMatchObject({ at: at(6), atEt: '08:06', quote: 'Why? We ruled R12 again?', priorClaim: 'Last claim', digestIds: ['R12'] });
    expect(result.corrections[1].priorClaim).toBe('');
    expect(result.wastedTurns.map((t) => t.kind)).toEqual(['corrected-claim']);
    expect(CORRECTION_PATTERNS.every((p) => p instanceof RegExp)).toBe(true);
  });

  it('detects every requested correction phrase and matches at least four ruling words at 60 percent', () => {
    const phrases = ['WHY', "didn't we", 'did not we', 'you could not', "you couldn't", 'I thought', 'careful', 'wrong', 'not what I', 'we ruled', 'we said', 'again?', 'stop'];
    const result = analyzeOrchestratorTurns([
      ...phrases.map((s) => turn('user', s)),
      turn('user', 'Careful: always prove live runtime behavior R8'),
    ], { window, digestIds: [
      { id: 'R1', quote: 'always prove live runtime behavior before loading' },
      { id: 'R2', quote: 'prove live' },
      { id: 'R3', quote: 'build inspect ship code elsewhere' },
    ] });
    expect(result.corrections).toHaveLength(14);
    expect(result.corrections.at(-1).digestIds).toEqual(['R1', 'R8']);
    expect(result.rulingMisses.map((r) => [r.id, r.count])).toEqual([['R1', 1], ['R8', 1]]);
  });

  it('counts only Agent/Task tool reports, excluding assistant brief quotes and other tools', () => {
    const result = analyzeOrchestratorTurns([
      ...workerStops.map((s) => assistant(s, 1)),
      toolCall('Bash', 'shell'), toolResult(workerStops[0], 2, 'shell'),
      toolResult(workerStops[0], 2, 'unknown'),
      toolCall('Agent', 'agent'), toolResult(workerStops[1], 3, 'agent'),
      toolCall('Task', 'task'), toolResult(workerStops[2], 4, 'task'),
    ], { window });
    expect(result.wastedTurns.map((t) => t.kind)).toEqual(['wrong-premise', 'wrong-premise']);
    expect(result.wastedTurns.map((t) => t.quote)).toEqual(workerStops.slice(1, 3));
    expect(result.corrections).toEqual([]);
  });

  it.each([
    ["Didn't we rule that any blocker are either debug or prototype", 'Didn’t we rule that any blocker are either debug or prototype'],
    ['Didn’t we rule that any blocker are either debug or prototype', "Didn't we rule that any blocker are either debug or prototype"],
    ['‘alpha’ “beta” gamma delta', "'alpha' \"beta\" gamma delta"],
  ])('normalizes curly punctuation in both digest and correction words: %s', (digestQuote, correction) => {
    const result = analyzeOrchestratorTurns([turn('user', correction.startsWith('Did') ? correction : `Careful ${correction}`)], {
      window, digestIds: [{ id: 'R1', quote: digestQuote }],
    });
    expect(result.corrections[0].digestIds).toEqual(['R1']);
  });

  it('de-duplicates streamed usage by message id, accepting a later cumulative update within the window', () => {
    const usage = (output) => ({ id: 'msg-1', content: [], usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 } });
    const result = analyzeOrchestratorTurns([
      turn('assistant', '', -1, { message: usage(1000) }),
      turn('assistant', '', 1, { message: usage(2) }),
      turn('assistant', '', 2, { message: usage(2) }),
      turn('assistant', '', 3, { message: usage(5) }),
      turn('assistant', '', 60, { message: { ...usage(1000), id: 'outside' } }),
    ], { window });
    expect(result.tokens).toEqual({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 });
  });

  it('tracks six real user turns after compact markers, with overlapping fallout counted once', () => {
    const result = analyzeOrchestratorTurns([
      { type: 'system', subtype: 'compact_boundary', timestamp: at(0) },
      turn('user', 'This session is being continued from a previous conversation', 1, { isCompactSummary: true }),
      toolResult('ordinary tool result', 2),
      turn('user', '<system-reminder>wrong</system-reminder>', 2),
      ...Array.from({ length: 7 }, (_, i) => turn('user', 'Careful', i + 3)),
    ], { window });
    expect(result.compactions).toHaveLength(2);
    expect(result.compactions.map((c) => c.correctionsAfter.length)).toEqual([6, 6]);
    expect(result.lostAfterCompaction).toBe(6);
    expect(result.frictions.find((f) => f.kind === 'lost-after-compaction').count).toBe(6);
  });

  it('redacts secrets, strips paths and caps all published quotes', () => {
    const secret = 'sk-ant-api03-' + 'a'.repeat(60);
    const s = `Wrong /Users/operator/private.txt /private/tmp/result token=${secret} ${'words '.repeat(80)}`;
    const result = analyzeOrchestratorTurns([assistant(s, 1), turn('user', s, 2)], { window });
    for (const q of [result.corrections[0].quote, result.corrections[0].priorClaim, ...result.wastedTurns.map((t) => t.quote), ...result.frictions.flatMap((f) => f.examples)]) {
      expect(q.length).toBeLessThanOrEqual(160);
      expect(q).toBe(redact(q));
      expect(q.includes(secret)).toBe(false);
      expect(q.includes('/Users/')).toBe(false);
      expect(q.includes('/private/')).toBe(false);
    }
  });
});
