// @vitest-environment node
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SOAK_PRECHECK_ENV, soakPrecheckEnabled, soakPrecheckAtOpen } from '../soak-precheck-at-open.mjs';
import { HOME_REASONS } from '../../operations/pr-land-reasons.mjs';

const fix = {
  title: 'fix(daemon-rebuild): stop losing a passing candidate',
  body: 'Preserve the passing candidate.',
  files: [{ path: 'scripts/lib/daemon-rebuild.mjs', changeType: 'MODIFIED' }],
  env: {},
};

describe('soak precheck at PR open', () => {
  const roots = [];
  afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
  const breakTest = 'scripts/conveyor/soak/breaks/new-untimed-break.soak.test.mjs';
  const unitTest = 'scripts/lib/__tests__/new-untimed-unit.test.mjs';
  function fixture(timing) {
    const repoRoot = mkdtempSync(join(tmpdir(), 'soak-timing-'));
    roots.push(repoRoot);
    const sidecar = join(repoRoot, `${breakTest}.timing.json`);
    mkdirSync(dirname(sidecar), { recursive: true });
    if (timing !== undefined) writeFileSync(sidecar, timing);
    return { repoRoot, sidecar };
  }
  const withTest = (changeType = 'ADDED') => [...fix.files, { path: breakTest, changeType }];

  it.each(['ADDED', 'RENAMED'])('passes a daemon fix with a timed %s soak break and untimed unit test', (changeType) => {
    const { repoRoot } = fixture('{"seconds":0.25}');
    const verdict = soakPrecheckAtOpen({ ...fix, repoRoot, files: [...fix.files,
      { path: 'scripts/conveyor/soak/breaks/new-untimed-break.mjs', changeType },
      { path: breakTest, changeType },
      { path: unitTest, changeType: 'ADDED' },
    ] });
    expect(verdict).toMatchObject({ ok: true, applicable: true });
  });
  it('passes a test-only PR with a timed soak break and untimed unit test', () => {
    const { repoRoot } = fixture('{"seconds":0.25}');
    expect(soakPrecheckAtOpen({ ...fix, repoRoot, title: 'test: add soak coverage', body: '',
      files: [breakTest, unitTest].map(path => ({ path, changeType: 'ADDED' })),
    })).toMatchObject({ ok: true, applicable: false });
  });
  it.each(['ADDED', 'RENAMED'])('refuses a missing sidecar for an %s soak test even with a shared timing', changeType => {
    const { repoRoot } = fixture();
    mkdirSync(join(repoRoot, 'scripts/ci'), { recursive: true });
    writeFileSync(join(repoRoot, 'scripts/ci/test-timings.json'), JSON.stringify({ soak: { [breakTest]: 1 } }));
    const verdict = soakPrecheckAtOpen({ ...fix, repoRoot, files: withTest(changeType) });
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain(`${breakTest}.timing.json`);
  });
  it.each([
    ['malformed JSON', '{'], ['null', 'null'], ['array', '[]'], ['scalar', '1'],
    ['missing seconds', '{}'], ['unknown field', '{"seconds":1,"other":true}'],
    ['string seconds', '{"seconds":"1"}'], ['boolean seconds', '{"seconds":true}'],
    ['null seconds', '{"seconds":null}'], ['zero', '{"seconds":0}'],
    ['negative', '{"seconds":-1}'], ['non-finite', '{"seconds":1e400}'],
  ])('refuses %s timing evidence', (_name, timing) => {
    const { repoRoot } = fixture(timing);
    expect(soakPrecheckAtOpen({ ...fix, repoRoot, files: withTest() }).ok).toBe(false);
  });
  it('refuses an unreadable sidecar instead of throwing or admitting', () => {
    const { repoRoot, sidecar } = fixture();
    mkdirSync(sidecar); // deterministic read failure, even for privileged test runners
    expect(soakPrecheckAtOpen({ ...fix, repoRoot, files: withTest() }).ok).toBe(false);
  });
  it.each(['test: add soak coverage', fix.title])('refuses untimed tests for %s even with a waiver', title => {
    const { repoRoot } = fixture();
    expect(soakPrecheckAtOpen({ ...fix, repoRoot, title, body: 'soak-waiver: existing coverage',
      files: [{ path: breakTest, changeType: 'ADDED' }],
    }).ok).toBe(false);
  });
  it('requires timing for every added test, not only the first', () => {
    const { repoRoot } = fixture('{"seconds":1}');
    expect(soakPrecheckAtOpen({ ...fix, repoRoot, files: [...withTest(),
      { path: breakTest.replace('new-untimed', 'second'), changeType: 'ADDED' },
    ] }).ok).toBe(false);
  });
  it.each([
    'scripts/conveyor/soak/new-baseline.soak.test.mjs',
    'scripts/conveyor/soak/breaks/nested/new.soak.test.mjs',
  ])('requires timing for a soak test at %s', path => {
    const { repoRoot } = fixture();
    expect(soakPrecheckAtOpen({ ...fix, repoRoot, files: [{ path, changeType: 'ADDED' }] }).ok).toBe(false);
  });
  it.each(['..', '.', '', '\\'])('refuses non-canonical path segment %s even if it resolves to a valid sidecar', segment => {
    const { repoRoot } = fixture('{"seconds":1}');
    const path = breakTest.replace('/new-untimed', `/${segment}/new-untimed`);
    const sidecar = join(repoRoot, `${path}.timing.json`);
    mkdirSync(dirname(sidecar), { recursive: true });
    writeFileSync(sidecar, '{"seconds":1}');
    expect(soakPrecheckAtOpen({ ...fix, repoRoot, files: [{ path, changeType: 'ADDED' }] }).ok).toBe(false);
  });
  it.each(['MODIFIED', 'DELETED'])('does not require a new sidecar for a %s soak test', changeType => {
    const { repoRoot } = fixture();
    expect(soakPrecheckAtOpen({ ...fix, repoRoot, title: 'test: existing coverage', body: '',
      files: [{ path: breakTest, changeType }],
    }).ok).toBe(true);
  });
  it('does not require timing sidecars for unit tests', () => {
    const { repoRoot } = fixture();
    expect(soakPrecheckAtOpen({ ...fix, repoRoot, title: 'test: unit coverage', body: '',
      files: [{ path: unitTest, changeType: 'ADDED' }],
    }).ok).toBe(true);
  });
  it('still refuses a daemon fix adding only a unit test without a soak break', () => {
    expect(soakPrecheckAtOpen({ ...fix, files: [...fix.files,
      { path: unitTest, changeType: 'ADDED' },
    ] })).toMatchObject({ ok: false, applicable: true });
  });
  describe('shared timing map independence', () => {
    let addedBreak;
    beforeEach(() => {
      const { repoRoot } = fixture('{"seconds":0.25}');
      addedBreak = {
        ...fix,
        repoRoot,
        title: 'test: add soak coverage',
        body: '',
        files: [{ path: breakTest, changeType: 'ADDED' }],
        timings: {},
      };
    });

    it('accepts a sidecar-measured soak break with no shared timing entry', () => {
      const verdict = soakPrecheckAtOpen(addedBreak);
      expect(verdict).toMatchObject({ ok: true });
      expect(verdict.missingTimings).toBeUndefined();
    });
    it.each(['ADDED', 'RENAMED'])('accepts a sidecar-measured %s break test without a shared timing', (changeType) => {
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
    it('never reads the shared timings file, even when it is unreadable', () => {
      mkdirSync(join(addedBreak.repoRoot, 'scripts/ci/test-timings.json'), { recursive: true });
      const readTimings = vi.fn(() => { throw new Error('must not read'); });
      expect(soakPrecheckAtOpen({ ...addedBreak, timings: undefined, readTimings }).ok).toBe(true);
      expect(readTimings).not.toHaveBeenCalled();
    });
    it('ignores a caller-supplied timings value of any shape', () => {
      for (const timings of [null, '2', 0, -2, NaN, Infinity, undefined, true, [], { [breakTest]: -1 }]) {
        expect(soakPrecheckAtOpen({ ...addedBreak, timings })).toEqual(soakPrecheckAtOpen(addedBreak));
      }
    });
    it('gives a break with and without a shared timing entry the identical verdict', () => {
      expect(soakPrecheckAtOpen({ ...addedBreak, timings: { [breakTest]: 2 } })).toEqual(soakPrecheckAtOpen(addedBreak));
    });
    it('accepts several sidecar-measured breaks without shared timings', () => {
      const files = ['a', 'b', 'c'].map(n => ({ path: `scripts/conveyor/soak/breaks/${n}.soak.test.mjs`, changeType: 'ADDED' }));
      files.forEach(({ path }) => writeFileSync(join(addedBreak.repoRoot, `${path}.timing.json`), '{"seconds":0.25}'));
      const verdict = soakPrecheckAtOpen({ ...addedBreak, files });
      expect(verdict.ok).toBe(true);
      expect(verdict.missingTimings).toBeUndefined();
      expect(verdict.message ?? '').not.toContain('test-timings.json');
    });
    it('does not require a test-timings.json edit next to an added break test', () => {
      const files = [{ path: breakTest, changeType: 'ADDED' }, { path: 'scripts/ci/test-timings.json', changeType: 'MODIFIED' }];
      expect(soakPrecheckAtOpen({ ...addedBreak, files }).ok).toBe(true);
      expect(soakPrecheckAtOpen({ ...addedBreak, files: files.slice(0, 1) }).ok).toBe(true);
    });
    it('accepts a daemon fix whose sidecar-measured break has no shared timing', () => {
      const files = [...fix.files, { path: breakTest, changeType: 'ADDED' }];
      expect(soakPrecheckAtOpen({ ...fix, repoRoot: addedBreak.repoRoot, files, timings: {} })).toMatchObject({ ok: true });
    });
    it('still refuses a daemon fix whose only added break file is deleted, even with a timed sibling', () => {
      const files = [...fix.files, { path: breakTest, changeType: 'DELETED' }];
      expect(soakPrecheckAtOpen({ ...fix, files, timings: { [breakTest]: 2 } }).ok).toBe(false);
    });
    it('treats a nested or non-test break the same with and without shared timings', () => {
      const nested = join(addedBreak.repoRoot, 'scripts/conveyor/soak/breaks/sub/x.soak.test.mjs.timing.json');
      mkdirSync(dirname(nested), { recursive: true });
      writeFileSync(nested, '{"seconds":0.25}');
      for (const path of ['scripts/conveyor/soak/breaks/sub/x.soak.test.mjs', 'scripts/conveyor/soak/breaks/x.mjs']) {
        const input = { ...addedBreak, files: [{ path, changeType: 'ADDED' }] };
        expect(soakPrecheckAtOpen(input).ok).toBe(true);
        expect(soakPrecheckAtOpen({ ...input, timings: { [path]: 2 } })).toEqual(soakPrecheckAtOpen(input));
      }
    });
    it('never mentions test-timings.json in a refusal message', () => {
      const verdict = soakPrecheckAtOpen(fix);
      expect(verdict.ok).toBe(false);
      expect(verdict.message).not.toContain('test-timings.json');
    });
    it('disables the check on opt-out', () => {
      expect(soakPrecheckAtOpen({ ...addedBreak, env: { [SOAK_PRECHECK_ENV]: '0' } }))
        .toEqual({ ok: true, skipped: 'disabled' });
    });
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
