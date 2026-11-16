/**
 * @file scripts/conveyor/health-smells/__tests__/launchd-ops-copy-drift.test.mjs
 * @description Fixture-driven (no real launchd, no real git): a launchd job running an out-of-repo copy of a
 * repo script that differs from origin/main is a finding; matching, counterpart-less and unreadable cases are not.
 */
import { describe, it, expect } from 'vitest';
import smell, { scanLaunchdOpsCopyDrift } from '../launchd-ops-copy-drift.mjs';
import { validateSmellShape } from '../../health-smells-shape.mjs';

const HOME = '/home/fixture';
const COPY = `${HOME}/ops/handoff/sync-guard-clone.mjs`;
const REPO_PATH = 'scripts/sync-guard-clone.mjs';
const DAY = 86_400_000;

function deps(over = {}) {
  const plists = over.plists ?? { 'com.we.guard.plist': { Label: 'com.we.guard', ProgramArguments: ['/usr/bin/node', COPY] } };
  return {
    home: HOME,
    listPlists: () => Object.keys(plists).concat(over.extraNames ?? []),
    readPlist: (name) => { if (!plists[name]) throw new Error('unreadable'); return plists[name]; },
    inGitCheckout: () => false,
    repoFilesByBasename: (b) => (b === 'sync-guard-clone.mjs' ? [REPO_PATH] : []),
    hashCopy: () => 'aaa',
    hashMain: () => 'aaa',
    copyMtimeMs: () => 10 * DAY,
    mainCommitMs: () => 13 * DAY,
    ...over.fn,
  };
}

describe('scanLaunchdOpsCopyDrift', () => {
  it('matching copy -> no finding', () => {
    expect(scanLaunchdOpsCopyDrift(deps())).toEqual([]);
  });

  it('drifted copy -> finding with label, copy path, repo path and staleness', () => {
    const out = scanLaunchdOpsCopyDrift(deps({ fn: { hashCopy: () => 'old' } }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      severity: 'medium', label: 'com.we.guard', copyPath: '~/ops/handoff/sync-guard-clone.mjs',
      repoPath: REPO_PATH, staleDays: 3,
    });
    expect(JSON.stringify(out)).not.toContain(HOME);
  });

  it('no repo counterpart -> no finding', () => {
    expect(scanLaunchdOpsCopyDrift(deps({ fn: { repoFilesByBasename: () => [] } }))).toEqual([]);
  });

  it('script inside a git checkout -> ignored', () => {
    expect(scanLaunchdOpsCopyDrift(deps({ fn: { hashCopy: () => 'old', inGitCheckout: () => true } }))).toEqual([]);
  });

  it('non com.we./com.plateau. jobs are ignored', () => {
    const plists = { 'com.other.x.plist': { Label: 'com.other.x', ProgramArguments: ['node', COPY] } };
    expect(scanLaunchdOpsCopyDrift(deps({ plists, fn: { hashCopy: () => 'old' } }))).toEqual([]);
  });

  it('unreadable plist -> low-severity note, others still scanned', () => {
    const out = scanLaunchdOpsCopyDrift(deps({ extraNames: ['com.plateau.bad.plist'], fn: { hashCopy: () => 'old' } }));
    expect(out.map((f) => f.severity).sort()).toEqual(['low', 'medium']);
    expect(out.find((f) => f.severity === 'low')).toMatchObject({ label: 'com.plateau.bad' });
  });

  it('missing origin/main file or unreadable copy -> low note, never a false drift', () => {
    const out = scanLaunchdOpsCopyDrift(deps({ fn: { hashMain: () => { throw new Error('no ref'); } } }));
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('low');
  });
});

describe('fail closed', () => {
  it('unreadable LaunchAgents dir -> low note, not an empty clean result', () => {
    const out = scanLaunchdOpsCopyDrift(deps({ fn: { listPlists: () => { throw new Error('EACCES'); } } }));
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('low');
  });

  it('job scope follows the plist Label, not the filename', () => {
    const plists = { 'renamed.plist': { Label: 'com.we.guard', ProgramArguments: ['node', COPY] } };
    const out = scanLaunchdOpsCopyDrift(deps({ plists, fn: { hashCopy: () => 'old' } }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ severity: 'medium', label: 'com.we.guard' });
  });

  it('an archived duplicate cannot mask drift; multiple live counterparts -> low ambiguity note', () => {
    const archived = scanLaunchdOpsCopyDrift(deps({ fn: {
      hashCopy: () => 'old', repoFilesByBasename: () => [REPO_PATH, 'scripts/archive/sync-guard-clone.mjs'],
      hashMain: (p) => (p.includes('archive') ? 'old' : 'aaa'),
    } }));
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatchObject({ severity: 'medium', repoPath: REPO_PATH });
    const ambiguous = scanLaunchdOpsCopyDrift(deps({ fn: { repoFilesByBasename: () => [REPO_PATH, 'scripts/other/sync-guard-clone.mjs'] } }));
    expect(ambiguous.map((f) => f.severity)).toEqual(['low']);
  });

  it('unverifiable findings still evaluate as breaches (unknown never reads clean)', () => {
    const r = smell.evaluate({}, { scan: () => [{ severity: 'low', label: 'com.we.x', note: 'plist unreadable' }] });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ subject: 'com.we.x', breach: true });
  });
});

describe('smell shape', () => {
  it('is a valid smell and maps findings to breaches', () => {
    expect(() => validateSmellShape(smell, 'launchd-ops-copy-drift.mjs')).not.toThrow();
    const r = smell.evaluate({}, { scan: () => [{ severity: 'medium', label: 'com.we.g', copyPath: '~/a.mjs', repoPath: 'scripts/a.mjs', staleDays: 2 }] });
    expect(r[0]).toMatchObject({ subject: 'com.we.g', breach: true });
  });
});
