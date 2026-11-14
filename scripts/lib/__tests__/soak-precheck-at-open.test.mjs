// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { SOAK_PRECHECK_ENV, soakPrecheckEnabled, soakPrecheckAtOpen } from '../soak-precheck-at-open.mjs';
import { HOME_REASONS } from '../../operations/pr-land-reasons.mjs';

const fix = {
  title: 'fix(daemon-rebuild): stop losing a passing candidate',
  body: 'Preserve the passing candidate.',
  files: [{ path: 'scripts/lib/daemon-rebuild.mjs', changeType: 'MODIFIED' }],
  env: {},
};

describe('soak precheck at PR open', () => {

  const breakTest = 'scripts/conveyor/soak/breaks/x.soak.test.mjs';
  const addedBreak = {
    ...fix,
    title: 'test: add soak coverage',
    body: '',
    files: [{ path: breakTest, changeType: 'ADDED' }],
    timings: {},
  };

  it.each(['ADDED', 'RENAMED'])('refuses an untimed %s break test even when replay is inapplicable', (changeType) => {
    const verdict = soakPrecheckAtOpen({ ...addedBreak, files: [{ path: breakTest, changeType }] });
    expect(verdict).toMatchObject({ ok: false, applicable: false, missingTimings: [breakTest] });
    expect(verdict.message).toContain(`"${breakTest}": 2`);
    expect(verdict.message).toContain('inside the "soak" object of scripts/ci/test-timings.json');
  });
  it('names every missing timing while excluding registered tests', () => {
    const other = 'scripts/conveyor/soak/breaks/y.soak.test.mjs';
    const timed = 'scripts/conveyor/soak/breaks/z.soak.test.mjs';
    const verdict = soakPrecheckAtOpen({ ...addedBreak,
      files: [breakTest, other, timed].map(path => ({ path, changeType: 'ADDED' })),
      timings: { [timed]: 2 },
    });
    expect(verdict.missingTimings).toEqual([breakTest, other]);
    for (const path of [breakTest, other]) expect(verdict.message).toContain(`"${path}": 2`);
    expect(verdict.message).not.toContain(timed);
  });
  it('leaves the result unchanged for a timed added break test', () => {
    const baseline = soakPrecheckAtOpen({ ...addedBreak, files: [{ path: breakTest, changeType: 'MODIFIED' }] });
    expect(soakPrecheckAtOpen({ ...addedBreak, timings: { [breakTest]: 2 } })).toEqual(baseline);
    expect(baseline.ok).toBe(true);
  });
  it('leaves the result unchanged when no break test is added', () => {
    const input = { ...fix, files: [{ path: 'README.md', changeType: 'ADDED' }] };
    expect(soakPrecheckAtOpen({ ...input, timings: {} })).toEqual(soakPrecheckAtOpen(input));
  });
  it.each(['MODIFIED', 'DELETED'])('does not refuse an untimed %s existing break test', (changeType) => {
    expect(soakPrecheckAtOpen({ ...addedBreak, files: [{ path: breakTest, changeType }] }))
      .toMatchObject({ ok: true });
  });
  it('loads soak timings from test-timings.json by default', () => {
    expect(soakPrecheckAtOpen({ ...addedBreak, timings: undefined }))
      .toMatchObject({ ok: false, missingTimings: [breakTest] });
  });
  it('disables the missing timing check on opt-out', () => {
    expect(soakPrecheckAtOpen({ ...addedBreak, timings: undefined, env: { [SOAK_PRECHECK_ENV]: '0' } }))
      .toEqual({ ok: true, skipped: 'disabled' });
  });
  it('refuses a daemon fix without replay evidence with actionable instructions', () => {
    const verdict = soakPrecheckAtOpen(fix);
    expect(verdict).toMatchObject({ ok: false, applicable: true });
    for (const text of ['scripts/conveyor/soak/breaks/', SOAK_PRECHECK_ENV]) {
      expect(verdict.message).toContain(text);
    }
    expect(verdict.message.toLowerCase()).not.toContain('waiver');
    expect(HOME_REASONS['soak-declaration']).toBe('refused');
  });
  it('passes with a waiver line', () => {
    expect(soakPrecheckAtOpen({ ...fix, body: 'soak-waiver: covered by pure replay' }).ok).toBe(true);
  });
  it('passes with an added break file', () => {
    expect(soakPrecheckAtOpen({ ...fix, files: [...fix.files,
      { path: 'scripts/conveyor/soak/breaks/rebuild-finalize-starved.mjs', changeType: 'ADDED' },
    ] }).ok).toBe(true);
  });
  it('does not accept a deleted break file as replay evidence', () => {
    expect(soakPrecheckAtOpen({ ...fix, files: [...fix.files,
      { path: 'scripts/conveyor/soak/breaks/old.mjs', changeType: 'DELETED' },
    ] }).ok).toBe(false);
  });
  it('passes outside daemon scope', () => {
    expect(soakPrecheckAtOpen({ ...fix, files: [{ path: 'README.md', changeType: 'MODIFIED' }] }))
      .toMatchObject({ ok: true, applicable: false });
  });
  it.each(['0', 'false', 'OFF', 'No'])('disables only on explicit opt-out %s', (value) => {
    const env = { [SOAK_PRECHECK_ENV]: value };
    expect(soakPrecheckEnabled(env)).toBe(false);
    expect(soakPrecheckAtOpen({ ...fix, env })).toEqual({ ok: true, skipped: 'disabled' });
  });
  it('defaults on when unset or not an opt-out', () => {
    expect(SOAK_PRECHECK_ENV).toBe('WE_PR_OPEN_SOAK_PRECHECK');
    for (const value of [undefined, '', '1', 'yes', 'unexpected']) {
      expect(soakPrecheckEnabled({ [SOAK_PRECHECK_ENV]: value })).toBe(true);
    }
    expect(soakPrecheckEnabled({})).toBe(true);
  });
});
