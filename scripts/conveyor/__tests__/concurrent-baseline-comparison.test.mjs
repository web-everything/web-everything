import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  OUTCOME_RANK, AGREEMENTS, compareTrialOutcomes, recordConcurrentBaselineComparison,
  dispatchDelegatedProvider, main,
} from '../concurrent-baseline-comparison.mjs';
import { readStore } from '../run-scorecard-store.mjs';

function memIo(initial = { version: 1, records: [] }) {
  let store = initial;
  return {
    read: () => JSON.stringify(store),
    write: (_p, s) => { store = JSON.parse(s); },
    exists: () => true,
  };
}

const baseTask = () => ({ description: 'Independently review+verify PR 2223', taskType: 'bugfix', item: 3690, pr: 2223 });
const baseClaude = () => ({ model: 'claude-sonnet-5-5', outcome: 'landed', verifiedBy: 'independent-claude', findings: null });
const baseDelegated = () => ({ provider: 'antigravity', model: 'claude-sonnet-4-6', outcome: 'rejected', verifiedBy: 'independent-claude', findings: 'No usable review verdict was ever delivered.' });

afterEach(() => vi.restoreAllMocks());

describe('compareTrialOutcomes', () => {
  it('ranks landed > reworked > rejected', () => {
    expect(OUTCOME_RANK.landed).toBeGreaterThan(OUTCOME_RANK.reworked);
    expect(OUTCOME_RANK.reworked).toBeGreaterThan(OUTCOME_RANK.rejected);
  });

  it('reports concordant-clean when both sides land', () => {
    const result = compareTrialOutcomes({ outcome: 'landed' }, { outcome: 'landed' });
    expect(result).toMatchObject({ agreement: AGREEMENTS.CONCORDANT_CLEAN, claudeOutcome: 'landed', delegatedOutcome: 'landed' });
    expect(result.summary).toContain('agree');
  });

  it('reports concordant-failed when both sides fall short, even at different ranks', () => {
    expect(compareTrialOutcomes({ outcome: 'rejected' }, { outcome: 'rejected' }).agreement).toBe(AGREEMENTS.CONCORDANT_FAILED);
  });

  it('reports claude-better when claude outranks the delegated side', () => {
    const result = compareTrialOutcomes({ outcome: 'landed' }, { outcome: 'rejected' });
    expect(result.agreement).toBe(AGREEMENTS.CLAUDE_BETTER);
  });

  it('reports delegated-better when the delegated side outranks claude', () => {
    const result = compareTrialOutcomes({ outcome: 'reworked' }, { outcome: 'landed' });
    expect(result.agreement).toBe(AGREEMENTS.DELEGATED_BETTER);
  });

  it('is pure: identical inputs always produce an identical result', () => {
    const a = compareTrialOutcomes({ outcome: 'landed' }, { outcome: 'reworked' });
    const b = compareTrialOutcomes({ outcome: 'landed' }, { outcome: 'reworked' });
    expect(a).toEqual(b);
  });

  it('rejects an unrecognized outcome on either side, by name', () => {
    expect(() => compareTrialOutcomes({ outcome: 'unknown' }, { outcome: 'landed' })).toThrow('claude side outcome');
    expect(() => compareTrialOutcomes({ outcome: 'landed' }, { outcome: 'unknown' })).toThrow('delegated side outcome');
  });
});

describe('recordConcurrentBaselineComparison', () => {
  it('writes two linked rows sharing one comparisonId, matching the PR 2223 precedent shape', () => {
    const io = memIo();
    const result = recordConcurrentBaselineComparison(baseTask(), baseClaude(), baseDelegated(), io, { idFn: () => 'cmp-fixed-1' });
    expect(result.comparisonId).toBe('cmp-fixed-1');
    expect(result.comparison.agreement).toBe(AGREEMENTS.CLAUDE_BETTER);
    expect(result.claudeRow).toMatchObject({
      provider: 'claude-native', model: 'claude-sonnet-5-5', outcome: 'landed',
      taskDescription: baseTask().description, taskType: 'bugfix', item: 3690, pr: 2223, comparisonId: 'cmp-fixed-1',
    });
    expect(result.delegatedRow).toMatchObject({
      provider: 'antigravity', model: 'claude-sonnet-4-6', outcome: 'rejected',
      taskDescription: baseTask().description, taskType: 'bugfix', item: 3690, pr: 2223, comparisonId: 'cmp-fixed-1',
    });
    expect(readStore(io).records).toHaveLength(2);
    expect(readStore(io).records.every((r) => r.comparisonId === 'cmp-fixed-1')).toBe(true);
  });

  it('defaults the claude side provider to claude-native when omitted', () => {
    const io = memIo();
    const result = recordConcurrentBaselineComparison(baseTask(), baseClaude(), baseDelegated(), io);
    expect(result.claudeRow.provider).toBe('claude-native');
  });

  it('honors an explicit claude provider override', () => {
    const io = memIo();
    const result = recordConcurrentBaselineComparison(baseTask(), { ...baseClaude(), provider: 'claude-opus' }, baseDelegated(), io);
    expect(result.claudeRow.provider).toBe('claude-opus');
  });

  it('mints a fresh comparisonId per call when idFn is not overridden', () => {
    const io = memIo();
    const first = recordConcurrentBaselineComparison(baseTask(), baseClaude(), baseDelegated(), io);
    const second = recordConcurrentBaselineComparison(baseTask(), baseClaude(), baseDelegated(), io);
    expect(first.comparisonId).not.toBe(second.comparisonId);
  });

  it('throws before any IO on an invalid task, without writing either row', () => {
    const io = memIo();
    expect(() => recordConcurrentBaselineComparison({ ...baseTask(), taskType: 'nonsense' }, baseClaude(), baseDelegated(), io))
      .toThrow('taskType');
    expect(readStore(io).records).toEqual([]);
  });

  it('throws before any IO when a side is missing a required field, naming the side', () => {
    const io = memIo();
    expect(() => recordConcurrentBaselineComparison(baseTask(), { ...baseClaude(), model: '' }, baseDelegated(), io))
      .toThrow('claude.model');
    expect(readStore(io).records).toEqual([]);

    expect(() => recordConcurrentBaselineComparison(baseTask(), baseClaude(), { ...baseDelegated(), provider: '' }, io))
      .toThrow('delegated.provider');
    expect(readStore(io).records).toEqual([]);
  });

  it('throws before any IO on an invalid outcome value on either side', () => {
    const io = memIo();
    expect(() => recordConcurrentBaselineComparison(baseTask(), { ...baseClaude(), outcome: 'bogus' }, baseDelegated(), io))
      .toThrow('claude.outcome');
    expect(readStore(io).records).toEqual([]);
  });

  it('passes informative/rootCause through per side, independently', () => {
    const io = memIo();
    const result = recordConcurrentBaselineComparison(
      baseTask(),
      { ...baseClaude(), informative: false, rootCause: null },
      { ...baseDelegated(), informative: true, rootCause: 'Antigravity sandbox swallowed the review output' },
      io,
    );
    expect(result.claudeRow.informative).toBe(false);
    expect(result.claudeRow.rootCause).toBeNull();
    expect(result.delegatedRow.informative).toBe(true);
    expect(result.delegatedRow.rootCause).toBe('Antigravity sandbox swallowed the review output');
  });

  it('rejects a secret-shaped finding on either side without writing (defers to logDelegationTrial\'s own scrub)', () => {
    const io = memIo();
    expect(() => recordConcurrentBaselineComparison(
      baseTask(), { ...baseClaude(), findings: 'leaked key AKI' + 'A1234567890ABCDEF' }, baseDelegated(), io,
    )).toThrow('secret scrub');
    expect(readStore(io).records).toEqual([]);
  });

  it('still attempts the delegated row when the claude row write fails, returning null only for the failed side', () => {
    let calls = 0;
    const io = {
      read: () => JSON.stringify({ version: 1, records: [] }),
      write: (_p, s) => {
        calls += 1;
        if (calls === 1) throw new Error('disk full');
      },
      exists: () => true,
    };
    const result = recordConcurrentBaselineComparison(baseTask(), baseClaude(), baseDelegated(), io);
    expect(result.claudeRow).toBeNull();
    expect(result.delegatedRow).not.toBeNull();
  });
});

describe('dispatchDelegatedProvider', () => {
  it('routes provider=codex to the injected codexTaskFn and tags the result with the provider', async () => {
    const codexTaskFn = vi.fn().mockResolvedValue({ diff: 'diff --git a/x b/x', gate: { ran: false } });
    const result = await dispatchDelegatedProvider({ provider: 'codex', task: 'do the thing', dir: '/tmp/x' }, { codexTaskFn });
    expect(codexTaskFn).toHaveBeenCalledWith({ task: 'do the thing', dir: '/tmp/x' });
    expect(result).toMatchObject({ provider: 'codex', diff: 'diff --git a/x b/x' });
  });

  it.each(['gemini', 'antigravity'])('routes provider=%s to the injected geminiTaskFn', async (provider) => {
    const geminiTaskFn = vi.fn().mockResolvedValue({ diff: '', gate: { ran: false } });
    const result = await dispatchDelegatedProvider({ provider, task: 'do the thing' }, { geminiTaskFn });
    expect(geminiTaskFn).toHaveBeenCalledWith({ task: 'do the thing' });
    expect(result.provider).toBe(provider);
  });

  it('rejects an unsupported provider by name, without calling either dispatcher', async () => {
    const codexTaskFn = vi.fn();
    const geminiTaskFn = vi.fn();
    await expect(dispatchDelegatedProvider({ provider: 'claude', task: 'x' }, { codexTaskFn, geminiTaskFn }))
      .rejects.toThrow("unsupported delegated provider 'claude'");
    expect(codexTaskFn).not.toHaveBeenCalled();
    expect(geminiTaskFn).not.toHaveBeenCalled();
  });
});

describe('concurrent-baseline-comparison CLI', () => {
  const args = [
    '--task=Independently review+verify PR 2223', '--task-type=bugfix', '--item=3690', '--pr=2223',
    '--claude-model=claude-sonnet-5-5', '--claude-outcome=landed', '--claude-verified-by=independent-claude',
    '--delegated-provider=antigravity', '--delegated-model=claude-sonnet-4-6',
    '--delegated-outcome=rejected', '--delegated-verified-by=independent-claude',
  ];

  it('parses both sides and prints the stored comparison as JSON', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const io = memIo();
    expect(main(args, io)).toBe(0);
    const printed = JSON.parse(log.mock.calls[0][0]);
    expect(printed.comparison.agreement).toBe(AGREEMENTS.CLAUDE_BETTER);
    expect(readStore(io).records).toHaveLength(2);
  });

  it('defaults claude-provider to claude-native', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const io = memIo();
    main(args, io);
    expect(readStore(io).records.find((r) => r.model === 'claude-sonnet-5-5').provider).toBe('claude-native');
  });

  it('prints help without writing', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const io = memIo();
    expect(main(['--help'], io)).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
    expect(readStore(io).records).toEqual([]);
  });

  it('reports invalid input with a non-zero exit and writes nothing', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const io = memIo();
    expect(main([...args, '--task-type=nonsense'], io)).toBe(1);
    expect(readStore(io).records).toEqual([]);
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining('concurrent-baseline-comparison:'));
  });

  it('reports an unknown flag with a non-zero exit', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(main([...args, '--unknown=x'], memIo())).toBe(1);
  });
});
