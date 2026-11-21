// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
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

  it('accepts an added soak break test with no timing entry — shard-assign median fallback places it', () => {
    const verdict = soakPrecheckAtOpen(addedBreak);
    expect(verdict).toMatchObject({ ok: true });
    expect(verdict.missingTimings).toBeUndefined();
  });
  it.each(['ADDED', 'RENAMED'])('accepts an untimed %s break test', (changeType) => {
    expect(soakPrecheckAtOpen({ ...addedBreak, files: [{ path: breakTest, changeType }] }).ok).toBe(true);
  });
  it('still refuses a daemon bug fix with only an untimed unrelated added file (replay gate kept)', () => {
    const verdict = soakPrecheckAtOpen({ ...fix,
      files: [...fix.files, { path: 'scripts/lib/new-helper.mjs', changeType: 'ADDED' }] });
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('scripts/conveyor/soak/breaks/');
  });
  it('leaves the result unchanged when no break test is added', () => {
    const input = { ...fix, files: [{ path: 'README.md', changeType: 'ADDED' }] };
    expect(soakPrecheckAtOpen({ ...input, timings: {} })).toEqual(soakPrecheckAtOpen(input));
  });
  it.each(['MODIFIED', 'DELETED'])('does not refuse an untimed %s existing break test', (changeType) => {
    expect(soakPrecheckAtOpen({ ...addedBreak, files: [{ path: breakTest, changeType }] }))
      .toMatchObject({ ok: true });
  });
  it('never reads the timings file, even when it is unreadable', () => {
    const readTimings = vi.fn(() => { throw new Error('must not read'); });
    expect(soakPrecheckAtOpen({ ...addedBreak, timings: undefined, readTimings }).ok).toBe(true);
    expect(readTimings).not.toHaveBeenCalled();
  });
  it('disables the check on opt-out', () => {
    expect(soakPrecheckAtOpen({ ...addedBreak, env: { [SOAK_PRECHECK_ENV]: '0' } }))
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
