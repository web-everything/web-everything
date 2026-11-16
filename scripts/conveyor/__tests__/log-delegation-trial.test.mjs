import { afterEach, describe, it, expect, vi } from 'vitest';
import { logDelegationTrial, main } from '../log-delegation-trial.mjs';
import { readStore } from '../run-scorecard-store.mjs';

const baseRow = () => ({
  provider: 'codex', model: 'gpt-6-astra', taskDescription: 'Fix a launch wrapper',
  taskType: 'bugfix', outcome: 'landed', verifiedBy: 'claude-subagent',
});

function memIo(initial = { version: 1, records: [] }) {
  let store = initial;
  return {
    read: () => JSON.stringify(store),
    write: (_p, s) => { store = JSON.parse(s); },
    exists: () => true,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('logDelegationTrial', () => {
  it('appends an unscored trial without replacing existing history', () => {
    const io = memIo({ version: 1, records: [{ existing: true }] });
    const input = {
      ...baseRow(), item: 3690, pr: 2223, findings: 'Review caught a quoting bug',
      outcome: 'reworked', verifiedBy: 'independent-claude', retroactive: true,
      scoredAt: '2026-09-15T01:00:00.000Z',
    };
    const stored = logDelegationTrial(input, io);
    expect(stored).toEqual({
      ...input, v: 1, subjectClass: 'work-agent', dispatchKind: 'session-delegation',
      rubricVersion: 'session-delegation.1', criteriaEvaluated: 0, score: null,
      deductions: [], handle: null, informative: false, rootCause: null, comparisonId: null,
      changedFiles: null,
    });
    expect(readStore(io).records).toEqual([{ existing: true }, stored]);
  });

  it('defaults findings/item/pr to null and retroactive to false, and stamps time', () => {
    const stored = logDelegationTrial(baseRow(), memIo());
    expect(stored.findings).toBeNull();
    expect(stored.item).toBeNull();
    expect(stored.pr).toBeNull();
    expect(stored.retroactive).toBe(false);
    expect(new Date(stored.scoredAt).toISOString()).toBe(stored.scoredAt);
  });

  it('accepts explicit informative true/false and writes an explicit false when the field is omitted (#3888, rule 4)', () => {
    const storedTrue = logDelegationTrial({ ...baseRow(), informative: true }, memIo());
    expect(storedTrue.informative).toBe(true);

    const storedFalse = logDelegationTrial({ ...baseRow(), informative: false }, memIo());
    expect(storedFalse.informative).toBe(false);

    const storedOmitted = logDelegationTrial(baseRow(), memIo());
    expect(Object.hasOwn(storedOmitted, 'informative')).toBe(true);
    expect(storedOmitted.informative).toBe(false);
  });

  it('rejects a non-boolean informative by name without writing (#3888, rule 4)', () => {
    for (const informative of ['true', 'false', 1, 0, null, 'yes']) {
      const io = memIo();
      expect(() => logDelegationTrial({ ...baseRow(), informative }, io)).toThrow('informative');
      expect(readStore(io).records).toEqual([]);
    }
  });

  it('accepts a non-empty rootCause string, or null, and writes it to its own field (#3889, rule 5)', () => {
    const storedText = logDelegationTrial({ ...baseRow(), rootCause: 'Stale merge-base cache after a force-push' }, memIo());
    expect(storedText.rootCause).toBe('Stale merge-base cache after a force-push');

    const storedNull = logDelegationTrial({ ...baseRow(), rootCause: null }, memIo());
    expect(storedNull.rootCause).toBeNull();

    const storedOmitted = logDelegationTrial(baseRow(), memIo());
    expect(Object.hasOwn(storedOmitted, 'rootCause')).toBe(true);
    expect(storedOmitted.rootCause).toBeNull();
  });

  it('rejects a rootCause that is not a non-empty string or null, by name, without writing (#3889, rule 5)', () => {
    for (const rootCause of ['', '  ', 123, false, true, 0]) {
      const io = memIo();
      expect(() => logDelegationTrial({ ...baseRow(), rootCause }, io)).toThrow('rootCause');
      expect(readStore(io).records).toEqual([]);
    }
  });

  it('writes findings and rootCause as two distinct fields, neither derived from the other (#3889, rule 5)', () => {
    const stored = logDelegationTrial({
      ...baseRow(),
      findings: 'Independent review caught a dropped merge-parent change',
      rootCause: 'Merge-base cache used a stale ref after a force-push',
    }, memIo());
    expect(stored.findings).toBe('Independent review caught a dropped merge-parent change');
    expect(stored.rootCause).toBe('Merge-base cache used a stale ref after a force-push');
    expect(stored.findings).not.toBe(stored.rootCause);

    // Setting only one never populates the other.
    const findingsOnly = logDelegationTrial({ ...baseRow(), findings: 'Just findings text' }, memIo());
    expect(findingsOnly.findings).toBe('Just findings text');
    expect(findingsOnly.rootCause).toBeNull();

    const rootCauseOnly = logDelegationTrial({ ...baseRow(), rootCause: 'Just a root cause' }, memIo());
    expect(rootCauseOnly.rootCause).toBe('Just a root cause');
    expect(rootCauseOnly.findings).toBeNull();
  });

  it('accepts a non-empty comparisonId string, or null, and writes it to its own field (#3783, #3690 Fork 2)', () => {
    const storedText = logDelegationTrial({ ...baseRow(), comparisonId: 'cmp-abc123' }, memIo());
    expect(storedText.comparisonId).toBe('cmp-abc123');

    const storedNull = logDelegationTrial({ ...baseRow(), comparisonId: null }, memIo());
    expect(storedNull.comparisonId).toBeNull();

    const storedOmitted = logDelegationTrial(baseRow(), memIo());
    expect(Object.hasOwn(storedOmitted, 'comparisonId')).toBe(true);
    expect(storedOmitted.comparisonId).toBeNull();
  });

  it('rejects a comparisonId that is not a non-empty string or null, by name, without writing (#3783)', () => {
    for (const comparisonId of ['', '  ', 123, false, true, 0]) {
      const io = memIo();
      expect(() => logDelegationTrial({ ...baseRow(), comparisonId }, io)).toThrow('comparisonId');
      expect(readStore(io).records).toEqual([]);
    }
  });

  it('rejects a secret-shaped comparisonId without writing (#3783, same scrub as findings/rootCause)', () => {
    const io = memIo();
    expect(() => logDelegationTrial({ ...baseRow(), comparisonId: 'leaked key AKI' + 'A1234567890ABCDEF' }, io)).toThrow('secret scrub');
    expect(readStore(io).records).toEqual([]);
  });

  it('accepts a changedFiles array, or null, and writes it to its own field (#4034 follow-up, card 4034b)', () => {
    const storedFiles = logDelegationTrial({ ...baseRow(), changedFiles: ['scripts/a.mjs', 'scripts/b.mjs'] }, memIo());
    expect(storedFiles.changedFiles).toEqual(['scripts/a.mjs', 'scripts/b.mjs']);

    const storedNull = logDelegationTrial({ ...baseRow(), changedFiles: null }, memIo());
    expect(storedNull.changedFiles).toBeNull();

    const storedOmitted = logDelegationTrial(baseRow(), memIo());
    expect(Object.hasOwn(storedOmitted, 'changedFiles')).toBe(true);
    expect(storedOmitted.changedFiles).toBeNull();

    const storedEmpty = logDelegationTrial({ ...baseRow(), changedFiles: [] }, memIo());
    expect(storedEmpty.changedFiles).toEqual([]);
  });

  it('rejects a changedFiles value that is not an array of non-empty strings or null, by name, without writing', () => {
    for (const changedFiles of ['scripts/a.mjs', 123, false, [1, 2], ['ok', ''], ['ok', '  ']]) {
      const io = memIo();
      expect(() => logDelegationTrial({ ...baseRow(), changedFiles }, io)).toThrow('changedFiles');
      expect(readStore(io).records).toEqual([]);
    }
  });

  it('CLI: --changed-files=a,b,c splits into an array, trimming entries', () => {
    const io = memIo();
    const code = main([
      '--provider=codex', '--model=gpt-6-astra', '--task=x', '--task-type=bugfix',
      '--outcome=landed', '--verified-by=claude-subagent', '--changed-files=a.mjs, b.mjs,c.mjs',
    ], io);
    expect(code).toBe(0);
    expect(readStore(io).records[0].changedFiles).toEqual(['a.mjs', 'b.mjs', 'c.mjs']);
  });

  it.each(['taskType', 'outcome', 'verifiedBy'])('rejects an invalid %s before writing', (field) => {
    const io = memIo();
    expect(() => logDelegationTrial({ ...baseRow(), [field]: 'invalid' }, io)).toThrow(field);
    expect(readStore(io).records).toEqual([]);
  });

  it.each(['provider', 'model', 'taskDescription'])('requires non-empty %s without coercion', (field) => {
    for (const value of [undefined, null, '', '  ', 123]) {
      const io = memIo();
      expect(() => logDelegationTrial({ ...baseRow(), [field]: value }, io)).toThrow(field);
      expect(readStore(io).records).toEqual([]);
    }
  });

  it.each(['item', 'pr'])('rejects invalid optional %s without coercion', (field) => {
    for (const value of [0, -1, 1.5, '2223', NaN, Infinity, false]) {
      expect(() => logDelegationTrial({ ...baseRow(), [field]: value }, memIo())).toThrow(field);
    }
  });

  it('rejects empty or non-string findings and non-boolean retroactive', () => {
    for (const findings of ['', '  ', 123, false]) {
      expect(() => logDelegationTrial({ ...baseRow(), findings }, memIo())).toThrow('findings');
    }
    for (const retroactive of [null, 'true', 0]) {
      expect(() => logDelegationTrial({ ...baseRow(), retroactive }, memIo())).toThrow('retroactive');
    }
  });

  it('accepts arbitrary provider/model identities and explicit null optional fields', () => {
    const input = { ...baseRow(), provider: 'future-provider', model: 'future-model', findings: null, item: null, pr: null };
    expect(logDelegationTrial(input, memIo())).toMatchObject(input);
  });

  it('rejects a secret-shaped provider/model/taskDescription/findings/rootCause without writing (independent review, PR #2267 round 1; rootCause added #3889)', () => {
    const secret = 'leaked key AKI' + 'A1234567890ABCDEF';
    for (const field of ['provider', 'model', 'taskDescription', 'findings', 'rootCause']) {
      const io = memIo();
      expect(() => logDelegationTrial({ ...baseRow(), [field]: secret }, io)).toThrow('secret scrub');
      expect(readStore(io).records).toEqual([]);
    }
  });

  it('accepts an ordinary description that names a script file (independent review, PR #2267 round 2)', () => {
    // Round 1's fix used the wide `scrubReasons`, whose "source file path/name" rule flagged any bare
    // `*.mjs` mention — which broke real backfill descriptions like this one. `scrubPublish` must not.
    const input = {
      ...baseRow(),
      taskDescription: "Self-fix codex-direct-task.mjs's own ENOBUFS failure",
      findings: 'Hardened codex-direct-task.mjs and gemini-direct-task.mjs after a real finding',
    };
    expect(logDelegationTrial(input, memIo())).toMatchObject(input);
  });

  it('rejects a missing or non-object row clearly', () => {
    for (const row of [undefined, null, 'trial', []]) {
      expect(() => logDelegationTrial(row, memIo())).toThrow('row must be an object');
    }
  });

  it('returns null on write failure, but still throws for invalid input', () => {
    const io = { ...memIo(), write: () => { throw new Error('disk full'); } };
    expect(logDelegationTrial(baseRow(), io)).toBeNull();
    expect(() => logDelegationTrial({ ...baseRow(), outcome: 'invalid' }, io)).toThrow('outcome');
  });
});

describe('log-delegation-trial CLI', () => {
  const args = ['--provider=codex', '--model=gpt-6-astra', '--task=Fix name=a b',
    '--task-type=bugfix', '--outcome=landed', '--verified-by=claude-subagent'];

  it('parses all flags and prints the stored JSON', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const io = memIo();
    expect(main([...args, '--findings=Fixed quoting', '--item=3690', '--pr=2223',
      '--scored-at=2026-09-15T01:00:00.000Z', '--retroactive'], io)).toBe(0);
    expect(JSON.parse(log.mock.calls[0][0])).toEqual(readStore(io).records[0]);
    expect(readStore(io).records[0]).toMatchObject({
      taskDescription: 'Fix name=a b', item: 3690, pr: 2223, retroactive: true,
      findings: 'Fixed quoting', scoredAt: '2026-09-15T01:00:00.000Z',
    });
  });

  it('parses --informative=true|false onto the row (#3888, rule 4)', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const io = memIo();
    expect(main([...args, '--informative=true'], io)).toBe(0);
    expect(readStore(io).records[0].informative).toBe(true);
    log.mockRestore();

    const io2 = memIo();
    expect(main([...args, '--informative=false'], io2)).toBe(0);
    expect(readStore(io2).records[0].informative).toBe(false);
  });

  it('defaults informative to an explicit false when the CLI flag is omitted (#3888, rule 4)', () => {
    const io = memIo();
    expect(main(args, io)).toBe(0);
    expect(Object.hasOwn(readStore(io).records[0], 'informative')).toBe(true);
    expect(readStore(io).records[0].informative).toBe(false);
  });

  it('rejects --informative with a non-true/false value by name, without writing (#3888, rule 4)', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const io = memIo();
    expect(main([...args, '--informative=yes'], io)).toBe(1);
    expect(readStore(io).records).toEqual([]);
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining('--informative must be true or false'));
  });

  it('parses --root-cause=TEXT onto its own rootCause field (#3889, rule 5)', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const io = memIo();
    expect(main([...args, '--root-cause=Stale merge-base cache after a force-push'], io)).toBe(0);
    expect(readStore(io).records[0].rootCause).toBe('Stale merge-base cache after a force-push');
    log.mockRestore();
  });

  it('defaults rootCause to null when the CLI flag is omitted (#3889, rule 5)', () => {
    const io = memIo();
    expect(main(args, io)).toBe(0);
    expect(Object.hasOwn(readStore(io).records[0], 'rootCause')).toBe(true);
    expect(readStore(io).records[0].rootCause).toBeNull();
  });

  it('rejects an empty --root-cause value by name, without writing (#3889, rule 5)', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const io = memIo();
    expect(main([...args, '--root-cause='], io)).toBe(1);
    expect(readStore(io).records).toEqual([]);
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining('rootCause'));
  });

  it('parses --comparison-id=TEXT onto its own comparisonId field (#3783, #3690 Fork 2)', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const io = memIo();
    expect(main([...args, '--comparison-id=cmp-abc123'], io)).toBe(0);
    expect(readStore(io).records[0].comparisonId).toBe('cmp-abc123');
    log.mockRestore();
  });

  it('defaults comparisonId to null when the CLI flag is omitted (#3783)', () => {
    const io = memIo();
    expect(main(args, io)).toBe(0);
    expect(Object.hasOwn(readStore(io).records[0], 'comparisonId')).toBe(true);
    expect(readStore(io).records[0].comparisonId).toBeNull();
  });

  it('rejects an empty --comparison-id value by name, without writing (#3783)', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const io = memIo();
    expect(main([...args, '--comparison-id='], io)).toBe(1);
    expect(readStore(io).records).toEqual([]);
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining('comparisonId'));
  });

  it('prints help without writing', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const io = memIo();
    expect(main(['--help'], io)).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
    expect(readStore(io).records).toEqual([]);
  });

  it('reports invalid flags, invalid input, and failed writes with non-zero exits', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const extra of ['--pr=2oops', '--item=', '--pr=1.5', '--unknown=x', '--retroactive=false']) {
      const io = memIo();
      expect(main([...args, extra], io)).toBe(1);
      expect(readStore(io).records).toEqual([]);
    }
    expect(main([], memIo())).toBe(1);
    expect(main(args, { ...memIo(), write: () => { throw new Error('disk full'); } })).toBe(1);
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining('could not write trial'));
  });
});
