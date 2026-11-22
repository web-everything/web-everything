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

  const breakTest = 'scripts/conveyor/soak/breaks/new-untimed-break.soak.test.mjs';
  const unitTest = 'scripts/lib/__tests__/new-untimed-unit.test.mjs';

  it.each(['ADDED', 'RENAMED'])('passes a daemon fix with an untimed %s soak break and added unit test', (changeType) => {
    // Neither new test has a timing entry; the PR does not edit test-timings.json.
    const verdict = soakPrecheckAtOpen({ ...fix, files: [...fix.files,
      { path: 'scripts/conveyor/soak/breaks/new-untimed-break.mjs', changeType },
      { path: breakTest, changeType },
      { path: unitTest, changeType: 'ADDED' },
    ] });
    expect(verdict).toMatchObject({ ok: true, applicable: true });
  });
  it('passes a test-only PR adding an untimed soak break test and unit test', () => {
    expect(soakPrecheckAtOpen({ ...fix, title: 'test: add soak coverage', body: '',
      files: [breakTest, unitTest].map(path => ({ path, changeType: 'ADDED' })),
    })).toMatchObject({ ok: true, applicable: false });
  });
  it('still refuses a daemon fix adding only a unit test without a soak break', () => {
    expect(soakPrecheckAtOpen({ ...fix, files: [...fix.files,
      { path: unitTest, changeType: 'ADDED' },
    ] })).toMatchObject({ ok: false, applicable: true });
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
