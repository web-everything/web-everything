/**
 * @file open-pr-io-org-shim.test.mjs — xpd70wx. open-pr / pr-land must use the org-aware gh shim (the daemons'
 * per-checkout one), because the legacy shared shim has no owner map and cannot see the plateauapp org
 * (plateau-app#217 was opened with raw `gh pr create`: no label-on-green, no review label).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveGhCredentialEnv, createPrLandRunner } from '../open-pr-io.mjs';
import { isOrgAwareShimDir, resolveOrgAwareShimDir, pathWithOrgAwareShim, defaultShimDir, shimGhPath } from '../../lib/gh-app-shim.mjs';

const ORG = '/h/.claude/github-app-token/gh-shim.d/abc';
const LEGACY = defaultShimDir();

// Card 6931 — a daemon's gh-shim refusal is the auth boundary: never swallowed into an unguarded fallback.
const GUARD = '/h/.claude/github-app-token/gh-shim.d/guard';
const DAEMONS = [['explicit', { WE_GH_DAEMON_CALLER: 'fix-daemon' }], ['XPC-only', { XPC_SERVICE_NAME: 'com.we.fix-daemon' }]];
const SHIM_ON_PATH = [['absent', '/usr/bin:/bin'], ['later', `/usr/bin:${GUARD}:/bin`], ['first', `${GUARD}:/usr/bin:/bin`]];
const writeFailed = () => { throw new Error('gh-shim: refusing daemon dispatch without the gh auth guard'); };
const builtShim = ({ pathEnv }) => ({ PATH: `${GUARD}:${pathEnv}`, WE_GH_DAEMON_CALLER: 'fix-daemon' });
/** Counts every fallback a refusal must never reach. */
function fallbacks() {
  const calls = { legacy: 0, org: 0 };
  return { calls, exists: (p) => { calls.legacy++; return p === shimGhPath(LEGACY); }, orgShimDir: () => { calls.org++; return ORG; } };
}

describe('createPrLandRunner — daemon gh guard refusal (card 6931)', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('createPrLandRunner refuses daemon shim installation errors before invoking gh', () => {
    for (const [, marker] of DAEMONS) {
      const fb = fallbacks();
      const gh = { spawn: 0, review: 0, dup: 0 };
      const run = createPrLandRunner({
        resolveEnv: () => resolveGhCredentialEnv({ env: { PATH: '/usr/bin', ...marker }, build: writeFailed, exists: fb.exists, orgShimDir: fb.orgShimDir }),
        prePrReview: () => { gh.review++; return { action: 'pass' }; },
        dupBornAs: () => { gh.dup++; return []; },
        spawn: () => { gh.spawn++; return { status: 0, stdout: '{"pr":1}' }; },
      });
      expect(run({ argv: ['--ref=lane/x'] })).toMatchObject({ outcome: 'refused', reason: 'gh-auth-guard-unavailable', detail: expect.stringMatching(/without the gh auth guard/) });
      expect(gh).toEqual({ spawn: 0, review: 0, dup: 0 });
      expect(fb.calls).toEqual({ legacy: 0, org: 0 });
    }
  });

  it('refuses through the real shim builder when a daemon has no real gh on PATH', () => {
    const empty = mkdtempSync(join(tmpdir(), 'open-pr-no-gh-'));
    try {
      for (const [, marker] of DAEMONS) {
        vi.unstubAllEnvs();
        vi.stubEnv('WE_GH_DAEMON_CALLER', marker.WE_GH_DAEMON_CALLER ?? '');
        vi.stubEnv('XPC_SERVICE_NAME', marker.XPC_SERVICE_NAME ?? '');
        vi.stubEnv('PATH', empty);
        let spawned = 0;
        const run = createPrLandRunner({ resolveEnv: () => resolveGhCredentialEnv(), prePrReview: () => ({ action: 'pass' }), spawn: () => { spawned++; return { status: 0, stdout: '{"pr":1}' }; } });
        expect(run({ argv: ['--ref=lane/x'] })).toMatchObject({ outcome: 'refused', reason: 'gh-auth-guard-unavailable', detail: expect.stringMatching(/without a real gh binary/) });
        expect(spawned).toBe(0);
      }
    } finally { rmSync(empty, { recursive: true, force: true }); }
  });
});

describe('resolveGhCredentialEnv — daemon markers × shim PATH position (card 6931)', () => {
  for (const [kind, marker] of DAEMONS) {
    it(`${kind} daemon: a failed shim write refuses, with no fallback reached`, () => {
      const fb = fallbacks();
      expect(() => resolveGhCredentialEnv({ env: { PATH: '/usr/bin', ...marker }, build: writeFailed, exists: fb.exists, orgShimDir: fb.orgShimDir })).toThrow(/without the gh auth guard/);
      expect(fb.calls).toEqual({ legacy: 0, org: 0 });
    });
    it(`${kind} daemon: a builder that returns no PATH refuses too`, () => {
      const fb = fallbacks();
      expect(() => resolveGhCredentialEnv({ env: { PATH: '/usr/bin', ...marker }, build: () => null, exists: fb.exists, orgShimDir: fb.orgShimDir })).toThrow(/without the gh auth guard/);
      expect(fb.calls).toEqual({ legacy: 0, org: 0 });
    });
    for (const [where, PATH] of SHIM_ON_PATH) {
      it(`${kind} daemon, guard dir ${where} on PATH: the guarded shim ends up first, once`, () => {
        const out = resolveGhCredentialEnv({ env: { PATH, ...marker }, build: builtShim, exists: () => true, orgShimDir: () => ORG });
        const parts = out.PATH.split(':');
        expect(parts[0]).toBe(GUARD);
        expect(parts.filter((d) => d === GUARD)).toHaveLength(1);
        expect(parts).toEqual([GUARD, '/usr/bin', '/bin']);
      });
    }
  }
  it('interactive: a failed shim write keeps the best-effort org-aware fallback', () => {
    const out = resolveGhCredentialEnv({ env: { PATH: '/usr/bin' }, build: writeFailed, exists: () => true, orgShimDir: () => ORG });
    expect(out.PATH.split(':')[0]).toBe(ORG);
  });
  it('interactive: an org-aware shim already first stays first, ahead of a legacy shim later on PATH', () => {
    for (const PATH of [`${ORG}:/usr/bin:${LEGACY}`, `${ORG}:/usr/bin`]) {
      const out = resolveGhCredentialEnv({ env: { PATH }, build: () => null, exists: () => true, orgShimDir: () => ORG });
      expect(out.PATH).toBe(PATH);
    }
  });
  for (const [where, PATH] of [['absent', '/usr/bin:/bin'], ['later', `/usr/bin:${LEGACY}:/bin`], ['first', `${LEGACY}:/usr/bin:/bin`]]) {
    it(`interactive, legacy shim ${where} on PATH: the legacy shim ends up first, once`, () => {
      const out = resolveGhCredentialEnv({ env: { PATH }, build: writeFailed, exists: () => true, orgShimDir: () => null });
      expect(out.PATH.split(':')).toEqual([LEGACY, '/usr/bin', '/bin']);
    });
  }
});

describe('resolveGhCredentialEnv — org-aware shim', () => {
  it('prefers the org-aware shim over the legacy one when no App env builds a shim', () => {
    const env = { PATH: '/usr/bin' };
    const out = resolveGhCredentialEnv({ env, build: () => null, exists: () => true, orgShimDir: () => ORG });
    expect(out.PATH.split(':')[0]).toBe(ORG);
    expect(out.PATH.split(':')).not.toContain(LEGACY);
  });
  it('replaces a legacy shim already on PATH', () => {
    const env = { PATH: `${LEGACY}:/usr/bin` };
    const out = resolveGhCredentialEnv({ env, build: () => null, exists: () => true, orgShimDir: () => ORG });
    expect(out.PATH).toBe(`${ORG}:/usr/bin`);
  });
  it('falls back to the legacy shim only when no org-aware shim exists', () => {
    const out = resolveGhCredentialEnv({ env: { PATH: '/usr/bin' }, build: () => null, exists: () => true, orgShimDir: () => null });
    expect(out.PATH.split(':')[0]).toBe(LEGACY);
  });
  it('keeps the freshly built per-checkout shim when App env is opted in', () => {
    const out = resolveGhCredentialEnv({ env: { PATH: '/usr/bin' }, build: () => ({ PATH: '/built:/usr/bin' }), orgShimDir: () => ORG });
    expect(out.PATH).toBe('/built:/usr/bin');
  });
  it('never puts a token in the returned env', () => {
    const out = resolveGhCredentialEnv({ env: { PATH: '/usr/bin' }, build: () => null, exists: () => true, orgShimDir: () => ORG });
    expect(JSON.stringify(out)).not.toMatch(/ghs_|GH_TOKEN|GITHUB_TOKEN/);
  });
});

describe('org-aware shim detection', () => {
  const read = (txt) => () => txt;
  it('knows an owner-map shim from a legacy one', () => {
    expect(isOrgAwareShimDir(ORG, { read: read('const OWNER_INSTALLATIONS = {};') })).toBe(true);
    expect(isOrgAwareShimDir(ORG, { read: read('#!/bin/sh legacy') })).toBe(false);
    expect(isOrgAwareShimDir(ORG, { read: () => { throw new Error('ENOENT'); } })).toBe(false);
  });
  it('resolveOrgAwareShimDir is null for a missing or legacy shim', () => {
    expect(resolveOrgAwareShimDir({ dir: ORG, exists: () => false })).toBeNull();
    expect(resolveOrgAwareShimDir({ dir: ORG, exists: () => true, read: read('legacy') })).toBeNull();
    expect(resolveOrgAwareShimDir({ dir: ORG, exists: () => true, read: read('OWNER_INSTALLATIONS') })).toBe(ORG);
  });
  it('pathWithOrgAwareShim is a no-op when already first or no org shim', () => {
    expect(pathWithOrgAwareShim({ pathEnv: `${ORG}:/usr/bin`, orgDir: ORG })).toBeNull();
    expect(pathWithOrgAwareShim({ pathEnv: '/usr/bin', orgDir: null })).toBeNull();
  });
});
