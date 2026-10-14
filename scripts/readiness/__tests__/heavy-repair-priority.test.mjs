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
