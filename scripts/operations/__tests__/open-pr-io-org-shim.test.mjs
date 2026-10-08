/**
 * @file open-pr-io-org-shim.test.mjs — xpd70wx. open-pr / pr-land must use the org-aware gh shim (the daemons'
 * per-checkout one), because the legacy shared shim has no owner map and cannot see the plateauapp org
 * (plateau-app#217 was opened with raw `gh pr create`: no label-on-green, no review label).
 */
import { describe, it, expect } from 'vitest';
import { resolveGhCredentialEnv } from '../open-pr-io.mjs';
import { isOrgAwareShimDir, resolveOrgAwareShimDir, pathWithOrgAwareShim, defaultShimDir } from '../../lib/gh-app-shim.mjs';

const ORG = '/h/.claude/github-app-token/gh-shim.d/abc';
const LEGACY = defaultShimDir();

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
