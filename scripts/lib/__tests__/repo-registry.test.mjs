/**
 * @file scripts/lib/__tests__/repo-registry.test.mjs
 * @description Pins the one repo registry (scripts/settings/repos.json) and its drift guard against the
 *   repo lists other settings files keep (REPO-REGISTRY-HEALTH).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadRepoRegistry, registryNames, validateRegistry, findRepo } from '../repo-registry.mjs';

const settings = (name) => JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'settings', name), 'utf8'));

describe('repo registry', () => {
  it('every repo in prototype-load, pr-sweep and review settings is in the registry', () => {
    const reg = loadRepoRegistry();
    const named = new Set();
    for (const d of Object.values(settings('prototype-load.json').daemons ?? {})) if (d.repo) named.add(d.repo);
    for (const s of settings('pr-sweep.json').prSweep.repos ?? []) named.add(s);
    for (const s of Object.keys(settings('review.json').review?.paths ?? settings('review.json').paths ?? {})) named.add(s);
    expect(named.size).toBeGreaterThan(0);
    for (const n of named) expect(findRepo(reg, n), `${n} missing from scripts/settings/repos.json`).toBeTruthy();
  });

  it('every entry carries the full schema', () => {
    const reg = loadRepoRegistry();
    expect(validateRegistry(reg)).toEqual([]);
    expect(registryNames(reg)).toEqual(expect.arrayContaining(['web-everything', 'plateau-app', 'frontierui']));
  });

  it('validateRegistry flags a missing field', () => {
    expect(validateRegistry({ repos: [{ name: 'x' }] }).length).toBeGreaterThan(0);
  });
});
