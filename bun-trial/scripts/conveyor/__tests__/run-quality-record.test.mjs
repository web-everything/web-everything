import { describe, it, expect, mock } from 'bun:test';
import { recordCodexRunScorecard, recordAntigravityRunScorecard } from '../../../../scripts/conveyor/run-quality-record.mjs';

const CLEAN_STDOUT = [
  '{"type":"thread.started","thread_id":"t1"}',
  '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"ls","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"ls","aggregated_output":"README.md\\n","exit_code":0,"status":"completed"}}',
  '{"type":"turn.completed","usage":{}}',
].join('\n');

describe('recordCodexRunScorecard (#3383 mechanical-dispatcher Bug 2 fix — the real call-site wiring)', () => {
  it('scores, classifies, stamps probation status, and appends — the full real composition', () => {
    const append = mock((row) => row);
    const statusFor = mock(() => 'probation');
    const row = recordCodexRunScorecard({
      stdout: CLEAN_STDOUT, dispatchKind: 'fix', role: 'delivery', model: 'gpt-6-astra', effort: 'medium',
      item: '3629', handle: 'fix-2108',
    }, { append, statusFor });

    expect(append).toHaveBeenCalledTimes(1);
    const [stored] = append.mock.calls[0];
    expect(stored.dispatchKind).toBe('fix');
    expect(stored.subjectClass).toBe('work-agent'); // 'fix' is a WORK_AGENT_KINDS member
    expect(stored.provider).toBe('codex');
    expect(stored.model).toBe('gpt-6-astra');
    expect(stored.effort).toBe('medium');
    expect(stored.item).toBe('3629');
    expect(stored.handle).toBe('fix-2108');
    expect(stored.probationStatus).toBe('probation');
    expect(stored.outcome).toBeNull(); // #3649 Fork 1 — joined later, never guessed here
    expect(typeof stored.score).toBe('number');
    expect(statusFor).toHaveBeenCalledWith({ provider: 'codex', model: 'gpt-6-astra', role: 'delivery' });
    expect(row).toBe(stored);
  });

  it('defaults `kind` to `dispatchKind` when the caller omits it — true for fix/ci-heal/build', () => {
    const classify = mock(() => 'work-agent');
    recordCodexRunScorecard(
      { stdout: CLEAN_STDOUT, dispatchKind: 'ci-heal', role: 'delivery', model: 'gpt-6-astra' },
      { classify, append: mock(), statusFor: mock(() => 'trusted') },
    );
    expect(classify).toHaveBeenCalledWith({ kind: 'ci-heal' });
  });

  it('the advisory-review call site names its own `kind` explicitly, distinct from `dispatchKind`', () => {
    const classify = mock(() => 'work-agent');
    recordCodexRunScorecard(
      {
        stdout: CLEAN_STDOUT, dispatchKind: 'advisory-review', kind: 'review', role: 'advisory-review', model: 'gpt-6-astra',
      },
      { classify, append: mock(), statusFor: mock(() => 'trusted') },
    );
    expect(classify).toHaveBeenCalledWith({ kind: 'review' });
  });

  it('NEVER THROWS — a scoring failure returns null rather than breaking the caller\'s real dispatch completion', () => {
    const scoreStdout = () => { throw new Error('boom'); };
    const result = recordCodexRunScorecard(
      { stdout: CLEAN_STDOUT, dispatchKind: 'fix', role: 'delivery', model: 'x' },
      { scoreStdout, append: mock() },
    );
    expect(result).toBeNull();
  });

  it('NEVER THROWS — a store-append failure (e.g. an invalid row) also returns null', () => {
    const append = () => { throw new Error('refusing to append an invalid scorecard'); };
    const result = recordCodexRunScorecard(
      { stdout: CLEAN_STDOUT, dispatchKind: 'fix', role: 'delivery', model: 'x' },
      { append, statusFor: mock(() => 'trusted') },
    );
    expect(result).toBeNull();
  });

  it('NEVER THROWS — an unknown `role` (statusFor\'s own refusal) also returns null, not an exception', () => {
    const result = recordCodexRunScorecard(
      { stdout: CLEAN_STDOUT, dispatchKind: 'fix', role: 'not-a-real-role', model: 'x' },
      { append: mock() },
    );
    expect(result).toBeNull();
  });

});

describe('recordAntigravityRunScorecard (#3383 mechanical-dispatcher Gap 1 fix — the real call-site wiring)', () => {
  it('scores a transcript FILE PATH (never raw stdout), classifies, stamps probation status, and appends', () => {
    const append = mock((row) => row);
    const statusFor = mock(() => 'probation');
    const scoreTranscript = mock(() => ({ rubricVersion: '2026-09-13.1', criteriaEvaluated: 1, deductions: [], score: 100 }));
    const row = recordAntigravityRunScorecard({
      transcriptFile: '/tmp/some-antigravity-judge-transcript.jsonl', dispatchKind: 'advisory-review',
      kind: 'review', role: 'advisory-review', model: 'gemini-3.1-pro', effort: 'low',
    }, { scoreTranscript, append, statusFor });

    expect(scoreTranscript).toHaveBeenCalledWith('/tmp/some-antigravity-judge-transcript.jsonl');
    expect(append).toHaveBeenCalledTimes(1);
    const [stored] = append.mock.calls[0];
    expect(stored.dispatchKind).toBe('advisory-review');
    expect(stored.subjectClass).toBe('work-agent'); // 'review' is a WORK_AGENT_KINDS member
    expect(stored.provider).toBe('antigravity');
    expect(stored.model).toBe('gemini-3.1-pro');
    expect(stored.effort).toBe('low');
    expect(stored.probationStatus).toBe('probation');
    expect(stored.outcome).toBeNull(); // #3649 Fork 1 — joined later, never guessed here
    expect(typeof stored.score).toBe('number');
    expect(statusFor).toHaveBeenCalledWith({ provider: 'antigravity', model: 'gemini-3.1-pro', role: 'advisory-review' });
    expect(row).toBe(stored);
  });

  it('defaults `provider` to `antigravity` and `kind` to `dispatchKind` when the caller omits them', () => {
    const classify = mock(() => 'work-agent');
    const statusFor = mock(() => 'trusted');
    recordAntigravityRunScorecard(
      { transcriptFile: '/tmp/t.jsonl', dispatchKind: 'advisory-review', role: 'advisory-review', model: 'gemini-3.1-pro' },
      { scoreTranscript: mock(() => ({ rubricVersion: 'x', criteriaEvaluated: 0, deductions: [], score: null })), classify, append: mock(), statusFor },
    );
    expect(classify).toHaveBeenCalledWith({ kind: 'advisory-review' });
    expect(statusFor).toHaveBeenCalledWith({ provider: 'antigravity', model: 'gemini-3.1-pro', role: 'advisory-review' });
  });

  it('NEVER THROWS — a scoring failure (e.g. `transcriptFile: null`, a failed persist) returns null', () => {
    const scoreTranscript = () => { throw new Error('boom'); };
    const result = recordAntigravityRunScorecard(
      { transcriptFile: null, dispatchKind: 'advisory-review', role: 'advisory-review', model: 'x' },
      { scoreTranscript, append: mock() },
    );
    expect(result).toBeNull();
  });

  it('NEVER THROWS — a store-append failure (e.g. an invalid row) also returns null', () => {
    const append = () => { throw new Error('refusing to append an invalid scorecard'); };
    const result = recordAntigravityRunScorecard(
      { transcriptFile: '/tmp/t.jsonl', dispatchKind: 'advisory-review', role: 'advisory-review', model: 'x' },
      { scoreTranscript: mock(() => ({ rubricVersion: 'x', criteriaEvaluated: 0, deductions: [], score: null })), append, statusFor: mock(() => 'trusted') },
    );
    expect(result).toBeNull();
  });

  it('NEVER THROWS — an unknown `role` (statusFor\'s own refusal) also returns null, not an exception', () => {
    const result = recordAntigravityRunScorecard(
      { transcriptFile: '/tmp/t.jsonl', dispatchKind: 'advisory-review', role: 'not-a-real-role', model: 'x' },
      { scoreTranscript: mock(() => ({ rubricVersion: 'x', criteriaEvaluated: 0, deductions: [], score: null })), append: mock() },
    );
    expect(result).toBeNull();
  });
});
