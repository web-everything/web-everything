/**
 * @file scripts/readiness/__tests__/heavy-repair-priority.test.mjs
 * @description Repair-language containment and deterministic matching-budget regression proof.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_REPAIR_PATTERNS, validRepairPatterns, classifyWaiterPriority, repairPatternMatches,
  MAX_REPAIR_PATTERN_LENGTH, MAX_REPAIR_MATCH_VALUE_LENGTH, MAX_REPAIR_PATTERNS,
  REPAIR_CLASSIFY_BUDGET_MS, REPAIR_MATCH_TIMEOUT_MS,
  DEFAULT_FIX_PATTERNS, DEFAULT_UNBLOCK_PATTERNS, UNBLOCK_ENV, validP1Patterns, classifyP1, rankOfClass,
} from '../heavy-repair-priority.mjs';

afterEach(() => vi.restoreAllMocks());
const classify = (identity, repairPatterns = DEFAULT_REPAIR_PATTERNS) =>
  classifyWaiterPriority(identity, { mode: 'enforce', repairPatterns });
const repairs = ['main-fix-abcdef0', 'main-fix-combine-42', 'revert-red-abcdef0', 'revert-red-42'];

describe('repair language is a subset of the built-in families', () => {
  it.each(['purpose', 'session', 'holder', 'envSession'])('recognizes every family and holder suffix in %s', (field) => {
    for (const repair of repairs) {
      for (const value of [repair, repair + '-lane-22-abc123']) {
        expect(classify({ [field]: value })).toMatchObject({ class: 'P0', matched: { field, value } });
        expect(validRepairPatterns(['^' + value + '$'])).toBe(true);
        expect(classify({ [field]: value }, ['^' + value + '$']).class).toBe('P0');
      }
    }
  });

  it('family and literal selections narrow classification, and an empty selection disables it', () => {
    expect(classify({ purpose: repairs[0] }, [DEFAULT_REPAIR_PATTERNS[0]]).class).toBe('P0');
    expect(classify({ purpose: repairs[1] }, [DEFAULT_REPAIR_PATTERNS[0]]).class).toBe('P3');
    expect(classify({ purpose: repairs[0] }, ['^main-fix-abcdef1$']).class).toBe('P3');
    expect(classify({ purpose: repairs[0] }, []).class).toBe('P3');
  });

  it.each(['.*', '^main-fix-.*$', '^main-fix-abcdef0$|ordinary', '^main-fix-(abcdef0|ordinary)$',
    'main-fix-', '^main-fix-abcdef0', '^main-fix-abcdef0(?=$)$', '^hotfix-42$', '(unclosed',
    '^main-fix-abcdef0$\n', '', 42, null])('rejects unsupported pattern %j as a whole with safe direct fallback', (bad) => {
    const mixed = ['^main-fix-abcdef0$', bad];
    expect(validRepairPatterns(mixed)).toBe(false);
    expect(classify({ purpose: 'ordinary' }, mixed).class).toBe('P3');
    expect(classify({ purpose: 'main-fix-combine-42' }, mixed).class).toBe('P0');
  });

  it.each([null, {}, '.*', [null]])('rejects malformed arrays %j', (bad) => {
    expect(validRepairPatterns(bad)).toBe(false);
    expect(classify({ purpose: 'ordinary' }, bad).class).toBe('P3');
  });

  it.each(['main-fix-queue-priority', 'revert-red-check', 'main-fix-abcdef', 'main-fix-abcdef0-tail',
    'main-fix-combine-x', 'prefix-main-fix-abcdef0'])('keeps ordinary identity %s at P3', (purpose) => {
    expect(classify({ purpose }).class).toBe('P3');
    expect(validRepairPatterns(['^' + purpose + '$'])).toBe(false);
  });

  it.each([1, 2])('bounds count and length with %i end markers independently of the accepted literal grammar', (endMarkers) => {
    const patterns = Array.from({ length: MAX_REPAIR_PATTERNS }, (_, i) => '^revert-red-' + i + '$');
    expect(validRepairPatterns(patterns)).toBe(true);
    expect(validRepairPatterns([...patterns, '^revert-red-99$'])).toBe(false);
    const literal = '^revert-red-' + '1'.repeat(MAX_REPAIR_PATTERN_LENGTH - 13) + '$';
    expect(literal.length).toBe(MAX_REPAIR_PATTERN_LENGTH);
    expect(validRepairPatterns([literal])).toBe(true);
    const oversized = (literal + '$'.repeat(endMarkers - 1)).replaceAll('$', '1$');
    expect(oversized).toBe(literal.slice(0, -1) + '1$'.repeat(endMarkers));
    expect(validRepairPatterns([oversized])).toBe(false);
  });

  it('skips oversized values even when a built-in family would match', () => {
    const value = 'revert-red-' + '1'.repeat(MAX_REPAIR_MATCH_VALUE_LENGTH - 11);
    expect(value.length).toBe(MAX_REPAIR_MATCH_VALUE_LENGTH);
    expect(classify({ purpose: value }).class).toBe('P0');
    expect(classify({ purpose: value + '1' }).class).toBe('P3');
    expect(classify({ purpose: value + '1', session: repairs[0] }).class).toBe('P0');
  });
});

describe('bounded matching after validation', () => {
  it('starts a 150ms deadline after validation, clips to the remaining budget, and never executes at exhaustion', () => {
    let clock = 1000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    // Array access during validation advances time: validation itself is outside the matching budget.
    const patterns = [...DEFAULT_REPAIR_PATTERNS];
    let validating = true;
    Object.defineProperty(patterns, '0', { get: () => { if (validating) { clock = 1200; validating = false; } return DEFAULT_REPAIR_PATTERNS[0]; } });
    const calls = [];
    const run = vi.spyOn(vm.Script.prototype, 'runInContext').mockImplementation((_context, options) => {
      calls.push({ at: clock, timeout: options.timeout });
      clock += calls.length === 1 ? 130 : 20;
      return false;
    });
    const result = classify({ purpose: 'ordinary', session: 'ordinary', holder: 'ordinary', envSession: 'ordinary' }, patterns);
    expect(result.class).toBe('P3');
    expect(REPAIR_CLASSIFY_BUDGET_MS).toBe(150);
    expect(REPAIR_MATCH_TIMEOUT_MS).toBe(50);
    expect(now.mock.results[0].value).toBe(1200);
    expect(calls).toEqual([{ at: 1200, timeout: 50 }, { at: 1330, timeout: 20 }]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not execute a match when less than one millisecond remains', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const run = vi.spyOn(vm.Script.prototype, 'runInContext');
    expect(repairPatternMatches(DEFAULT_REPAIR_PATTERNS[0], repairs[0], 1000.9)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('cuts off catastrophic backtracking in the low-level matcher under a child watchdog', () => {
    const moduleUrl = pathToFileURL(resolve('scripts/readiness/heavy-repair-priority.mjs')).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { repairPatternMatches } from ${JSON.stringify(moduleUrl)};
      console.log(JSON.stringify([
        repairPatternMatches('^(a|aa)+$', 'a'.repeat(70) + 'b'),
        repairPatternMatches('^revert-red-42$', 'revert-red-42')
      ]));
    `], { encoding: 'utf8', timeout: 8000 });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual([false, true]);
  });
});


describe('P1 fixes and unblocking builds (R203)', () => {
  const policy = (overrides = {}) => ({ mode: 'enforce', fixPatterns: DEFAULT_FIX_PATTERNS, unblockPatterns: DEFAULT_UNBLOCK_PATTERNS, ...overrides });

  it('exports the bounded default families and explicit environment marker', () => {
    expect(DEFAULT_FIX_PATTERNS).toEqual(['^fix-\\d+(?:-lane-\\d+-[0-9a-f]+)?$', '^ci-heal-\\d+(?:-lane-\\d+-[0-9a-f]+)?$']);
    expect(DEFAULT_UNBLOCK_PATTERNS).toEqual(['^unblock-[a-z0-9][a-z0-9-]*(?:-lane-\\d+-[0-9a-f]+)?$']);
    expect(UNBLOCK_ENV).toBe('WE_HEAVY_UNBLOCK');
  });

  it.each(['purpose', 'session', 'holder', 'envSession'])('recognizes fix and ci-heal identities in %s, including lane suffixes', (field) => {
    for (const value of ['fix-203', 'ci-heal-42', 'fix-203-lane-47-abc123', 'ci-heal-42-lane-47-abc123']) {
      expect(classifyP1({ [field]: value }, policy())).toMatchObject({ class: 'P1', kind: 'fix', matched: { field, value }, reason: expect.any(String) });
    }
  });

  it.each(['unblock-host', 'unblock-build-203', 'unblock-host-lane-47-abc123'])('recognizes unblocking purpose %s', (purpose) => {
    expect(classifyP1({ purpose }, policy())).toMatchObject({ class: 'P1', kind: 'unblock', matched: { field: 'purpose', value: purpose } });
  });

  it('WE_HEAVY_UNBLOCK=1, decoded as a boolean, marks an ordinary build as unblocking', () => {
    expect(classifyP1({ purpose: 'build-203', unblockEnv: true }, policy())).toMatchObject({ class: 'P1', kind: 'unblock' });
    for (const unblockEnv of [false, undefined, '1', 1]) {
      expect(classifyP1({ purpose: 'build-203', unblockEnv }, policy())).toMatchObject({ class: null, kind: null, matched: null });
    }
  });

  it.each(['build-203', 'review-203', 'prefix-fix-203', 'fix-feature', 'ci-heal-host', 'unblock-', 'unblock-UPPER'])('does not promote ordinary or near-match purpose %s', (purpose) => {
    expect(classifyP1({ purpose }, policy())).toMatchObject({ class: null, kind: null, matched: null });
  });

  it('mode off disables both pattern and environment promotion', () => {
    for (const identity of [{ purpose: 'fix-203' }, { purpose: 'unblock-host' }, { purpose: 'build-203', unblockEnv: true }]) {
      expect(classifyP1(identity, policy({ mode: 'off' }))).toMatchObject({ class: null, kind: null, matched: null });
    }
  });

  it('accepts empty selections, safe custom patterns, and the exact count and length bounds', () => {
    expect(validP1Patterns([])).toBe(true);
    expect(validP1Patterns(['^custom-fix-[0-9]+$'])).toBe(true);
    expect(validP1Patterns(Array(16).fill('^fix-1$'))).toBe(true);
    expect(validP1Patterns(['a'.repeat(MAX_REPAIR_PATTERN_LENGTH)])).toBe(true);
    expect(classifyP1({ purpose: 'custom-fix-8' }, policy({ fixPatterns: ['^custom-fix-[0-9]+$'] }))).toMatchObject({ class: 'P1', kind: 'fix' });
    for (const purpose of ['fix-203', 'unblock-host']) {
      expect(classifyP1({ purpose }, policy({ fixPatterns: [], unblockPatterns: [] })).class).toBeNull();
    }
  });

  const invalidLayers = [
    ['unsafe nested repeat', ['^custom$', '^(a+)+$']],
    ['oversized pattern list', Array(17).fill('^custom$')],
    ['overlong pattern', ['a'.repeat(MAX_REPAIR_PATTERN_LENGTH + 1)]],
    ['non-string entry', ['^custom$', 42]],
    ['malformed regex', ['(']],
    ['missing array', null],
    ['non-array', '^custom$'],
  ];
  it.each(invalidLayers)('rejects the whole %s layer and falls back to the default families', (_label, patterns) => {
    expect(validP1Patterns(patterns)).toBe(false);
    expect(classifyP1({ purpose: 'fix-203' }, policy({ fixPatterns: patterns }))).toMatchObject({ class: 'P1', kind: 'fix' });
    expect(classifyP1({ purpose: 'unblock-host' }, policy({ unblockPatterns: patterns }))).toMatchObject({ class: 'P1', kind: 'unblock' });
    expect(classifyP1({ purpose: 'custom' }, policy({ fixPatterns: patterns, unblockPatterns: patterns })).class).toBeNull();
  });

  it('bounds all P1 matching by the shared classification deadline', () => {
    let clock = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const calls = [];
    vi.spyOn(vm.Script.prototype, 'runInContext').mockImplementation((_context, options) => {
      calls.push({ at: clock, timeout: options.timeout });
      clock += calls.length === 1 ? 130 : 20;
      return false;
    });
    expect(classifyP1({ purpose: 'ordinary', session: 'ordinary', holder: 'ordinary', envSession: 'ordinary' }, policy()).class).toBeNull();
    expect(calls).toEqual([{ at: 1000, timeout: 50 }, { at: 1130, timeout: 20 }]);
  });

  it('keeps P0 above P1 and leaves red-main repair classification unchanged', () => {
    expect(rankOfClass('P0')).toBe(0);
    expect(rankOfClass('P1')).toBe(1);
    for (const cls of ['P2', 'P3', null, undefined, 'unknown']) expect(rankOfClass(cls)).toBe(2);
    const identity = { purpose: 'main-fix-abcdef0' };
    expect(classify(identity).class).toBe('P0');
    expect(classifyP1(identity, policy())).toMatchObject({ class: null, kind: null, matched: null });
  });
});
