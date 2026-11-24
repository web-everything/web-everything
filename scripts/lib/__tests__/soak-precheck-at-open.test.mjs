// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { SOAK_PRECHECK_ENV, soakPrecheckEnabled, soakPrecheckAtOpen, parseSoakNameStatus } from '../soak-precheck-at-open.mjs';
import { HOME_REASONS } from '../../operations/pr-land-reasons.mjs';

const breakTest = 'scripts/conveyor/soak/breaks/new-untimed-break.soak.test.mjs';
const unitTest = 'scripts/lib/__tests__/new-untimed-unit.test.mjs';
const fix = {
  title: 'fix(daemon-rebuild): stop losing a passing candidate',
  body: 'Preserve the passing candidate.',
  files: [{ path: 'scripts/lib/daemon-rebuild.mjs', changeType: 'MODIFIED' }],
  env: {},
};
const withTest = (changeType = 'ADDED') => [...fix.files, { path: breakTest, changeType }];

describe('soak precheck at PR open', () => {
  it.each(['ADDED', 'RENAMED'])('accepts an untimed %s soak break without any sidecar or shared timing', changeType => {
    expect(soakPrecheckAtOpen({ ...fix, files: withTest(changeType) }))
      .toMatchObject({ ok: true, applicable: true });
  });
  it.each(['test: add soak coverage', fix.title])('accepts untimed tests for %s including waived fixes', title => {
    const files = [breakTest, unitTest].map(path => ({ path, changeType: 'ADDED' }));
    expect(soakPrecheckAtOpen({ ...fix, title, body: '', files }).ok).toBe(true);
    expect(soakPrecheckAtOpen({ ...fix, title, body: 'soak-waiver: existing coverage', files }).ok).toBe(true);
  });
  it('treats a bare break path as replay evidence without requiring timing metadata', () => {
    expect(soakPrecheckAtOpen({ ...fix, files: [...fix.files, breakTest] }).ok).toBe(true);
  });
  it('accepts multiple untimed tests, nested breaks and baseline tests', () => {
    const files = [breakTest, 'scripts/conveyor/soak/breaks/sub/x.soak.test.mjs',
      'scripts/conveyor/soak/baseline.soak.test.mjs', unitTest].map(path => ({ path, changeType: 'ADDED' }));
    expect(soakPrecheckAtOpen({ ...fix, files: [...fix.files, ...files] }).ok).toBe(true);
  });
  it.each(['MODIFIED', 'DELETED'])('accepts an untimed %s test-only change', changeType => {
    expect(soakPrecheckAtOpen({ ...fix, title: 'test: coverage', body: '',
      files: [{ path: breakTest, changeType }] }).ok).toBe(true);
  });
  it.each([null, '2', 0, -2, NaN, Infinity, undefined, true, [], { [breakTest]: -1 }])('ignores shared timing metadata %j', timings => {
    const input = { ...fix, files: withTest() };
    const readTimings = vi.fn(() => { throw new Error('must not read'); });
    expect(soakPrecheckAtOpen({ ...input, timings, readTimings })).toEqual(soakPrecheckAtOpen(input));
    expect(readTimings).not.toHaveBeenCalled();
  });
  it('does not require a shared timings edit next to an added break', () => {
    const input = { ...fix, files: withTest() };
    expect(soakPrecheckAtOpen(input).ok).toBe(true);
    expect(soakPrecheckAtOpen({ ...input, files: [...input.files,
      { path: 'scripts/ci/test-timings.json', changeType: 'MODIFIED' }] })).toEqual(soakPrecheckAtOpen(input));
  });
  it.each([
    { path: '"docs/\\303\\251.md"', changeType: 'MODIFIED' },
    { path: 'docs/a\\b.md', changeType: 'MODIFIED' },
    { path: 'docs/é.md', changeType: 'TYPE_CHANGED' },
    { path: 'docs/example.md', changeType: 'UNMERGED' },
    { path: 'docs/example.md', changeType: 'UNKNOWN' },
  ])('accepts unrelated file metadata %j', file => {
    expect(soakPrecheckAtOpen({ ...fix, files: [file] })).toMatchObject({ ok: true, applicable: false });
    expect(soakPrecheckAtOpen({ ...fix, files: [...withTest(), file] }).ok).toBe(true);
  });
  it.each([undefined, null, '', 'UNKNOWN', 'UNMERGED', 'A', 'COPIED', 'ADDED\n'])('refuses unknown daemon change type %s', changeType => {
    expect(soakPrecheckAtOpen({ ...fix, files: [{ path: breakTest, changeType }] }))
      .toMatchObject({ ok: false, reason: 'unknown file change type' });
  });
  it.each([undefined, null, {}, [null], [{ path: '' }]])('refuses incomplete file metadata %j', files => {
    expect(soakPrecheckAtOpen({ ...fix, title: 'test: coverage', files }).ok).toBe(false);
  });
  it.each(['..', '.', ''])('refuses non-canonical daemon path segment %j', segment => {
    const path = breakTest.replace('/new-untimed', '/' + segment + '/new-untimed');
    expect(soakPrecheckAtOpen({ ...fix, files: [{ path, changeType: 'ADDED' }] }).ok).toBe(false);
  });
  it('refuses a daemon fix without replay evidence with actionable instructions', () => {
    const verdict = soakPrecheckAtOpen(fix);
    expect(verdict).toMatchObject({ ok: false, applicable: true });
    expect(verdict.message).toContain('scripts/conveyor/soak/breaks/');
    expect(verdict.message).toContain(SOAK_PRECHECK_ENV);
    expect(verdict.message.toLowerCase()).not.toContain('waiver');
    expect(verdict.message).not.toContain('test-timings.json');
    expect(HOME_REASONS['soak-declaration']).toBe('refused');
  });
  it('still refuses a daemon fix adding only an untimed unit test', () => {
    expect(soakPrecheckAtOpen({ ...fix, files: [...fix.files,
      { path: unitTest, changeType: 'ADDED' }] })).toMatchObject({ ok: false, applicable: true });
  });
  it('passes with a waiver line', () => {
    expect(soakPrecheckAtOpen({ ...fix, body: 'soak-waiver: covered by pure replay' }).ok).toBe(true);
  });
  it('passes with an added break module', () => {
    expect(soakPrecheckAtOpen({ ...fix, files: [...fix.files,
      { path: 'scripts/conveyor/soak/breaks/rebuild-finalize-starved.mjs', changeType: 'ADDED' }] }).ok).toBe(true);
  });
  it('does not accept a deleted break file even with a stored timing', () => {
    expect(soakPrecheckAtOpen({ ...fix, files: withTest('DELETED'), timings: { [breakTest]: 2 } }).ok).toBe(false);
  });
  it('passes outside daemon scope', () => {
    expect(soakPrecheckAtOpen({ ...fix, files: [{ path: 'README.md', changeType: 'MODIFIED' }] }))
      .toMatchObject({ ok: true, applicable: false });
  });
  it.each(['0', 'false', 'OFF', 'No'])('disables only on explicit opt-out %s', value => {
    const env = { [SOAK_PRECHECK_ENV]: value };
    expect(soakPrecheckEnabled(env)).toBe(false);
    expect(soakPrecheckAtOpen({ ...fix, env })).toEqual({ ok: true, skipped: 'disabled' });
  });
  it.each([undefined, '', '1', 'yes', 'unexpected'])('defaults on for %j', value => {
    expect(SOAK_PRECHECK_ENV).toBe('WE_PR_OPEN_SOAK_PRECHECK');
    expect(soakPrecheckEnabled({ [SOAK_PRECHECK_ENV]: value })).toBe(true);
  });
});

describe('NUL-delimited admission diff parser', () => {
  it('accepts an empty diff', () => {
    expect(parseSoakNameStatus('')).toEqual([]);
  });
  it.each(['R100', 'C100', 'R095', 'C075', 'R5', 'C00'])('uses the destination of %s', code => {
    expect(parseSoakNameStatus(code + '\0old\0' + breakTest + '\0'))
      .toEqual([{ path: breakTest, changeType: code[0] === 'R' ? 'RENAMED' : 'ADDED' }]);
  });
  it.each(['é', 'a\tb', 'a\nb', 'a\rb', 'a"b', 'a\\b', '\x60echo x\x60', '--name', 'a\u2028b', 'e\u0301', 'a\u200bb', 'trailing '])('preserves filename bytes %j', name => {
    expect(parseSoakNameStatus('A\0' + name + '\0')).toEqual([{ path: name, changeType: 'ADDED' }]);
  });
  it.each(['T', 'U', 'X'])('scopes %s status validation to daemon paths', code => {
    const files = parseSoakNameStatus(code + '\0docs/é.md\0');
    expect(soakPrecheckAtOpen({ ...fix, files }).ok).toBe(true);
    const daemonFiles = parseSoakNameStatus(code + '\0scripts/lib/daemon-rebuild.mjs\0');
    expect(soakPrecheckAtOpen({ ...fix, files: daemonFiles, body: 'soak-waiver: existing break' }).ok).toBe(code === 'T');
  });
  it.each([null, undefined, 'M\tREADME.md', 'A\0new', 'R100\0old\0', 'A\0\0',
    'Q\0file\0', 'R101\0old\0new\0', 'C1000\0old\0new\0', 'M\0file\0\0'])('refuses incomplete or malformed output %j', diff => {
    expect(() => parseSoakNameStatus(diff)).toThrow();
  });
});
