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
import { CONSTELLATION_REPOS } from '../constellation-repos.mjs';

const settings = (name) => JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'settings', name), 'utf8'));

const repoSources = ({ prototypeLoad, prSweep, review }) => ({
  prototypeLoad: Object.values(prototypeLoad.daemons).map((d) => d.repo).filter(Boolean),
  prSweep: prSweep.prSweep.repos,
  uiFastLane: Object.keys(review.uiFastLane.paths),
  cardOnly: review.autoRoundGrant.cardOnly.repos,
});
const assertRegistered = (reg, sources) => {
  for (const [source, names] of Object.entries(sources)) {
    expect(names.length, `${source} must contribute repos`).toBeGreaterThan(0);
    for (const n of names) expect(findRepo(reg, n), `${source}: ${n} missing from scripts/settings/repos.json`).toBeTruthy();
  }
};

describe('repo registry', () => {
  it('every repo in prototype-load, pr-sweep and review settings is in the registry', () => {
    const reg = loadRepoRegistry();
    assertRegistered(reg, repoSources({
      prototypeLoad: settings('prototype-load.json'), prSweep: settings('pr-sweep.json'), review: settings('review.json'),
    }));
  });

  it.each(['uiFastLane', 'cardOnly'])('rejects unregistered repos in review %s', (source) => {
    const review = settings('review.json');
    if (source === 'uiFastLane') review.uiFastLane.paths = { 'bogus/unregistered': [] };
    else review.autoRoundGrant.cardOnly.repos = ['bogus/unregistered'];
    const sources = repoSources({ prototypeLoad: settings('prototype-load.json'), prSweep: settings('pr-sweep.json'), review });
    expect(() => assertRegistered(loadRepoRegistry(), sources)).toThrow(/bogus\/unregistered missing/);
  });

  it.each(['prototypeLoad', 'prSweep', 'uiFastLane', 'cardOnly'])('refuses an empty %s extraction', (source) => {
    expect(() => assertRegistered(loadRepoRegistry(), { [source]: [] })).toThrow(/must contribute repos/);
  });

  it('uses every constellation repo slug as a canonical registry slug', () => {
    const reg = loadRepoRegistry();
    for (const { slug } of Object.values(CONSTELLATION_REPOS)) expect(reg.repos.some((r) => r.slug === slug), slug).toBe(true);
  });

  it('finds a repo by name, slug, slug tail and alias', () => {
    const entry = { name: 'display-name', slug: 'owner/slug-tail', aliases: ['legacy/name'] };
    for (const key of ['display-name', 'owner/slug-tail', 'slug-tail', 'legacy/name']) {
      expect(findRepo({ repos: [entry] }, key)).toBe(entry);
    }
    expect(findRepo({ repos: [entry] }, 'unregistered/repo')).toBeNull();
  });

  it('retains lookup aliases for the pre-transfer slugs', () => {
    const reg = loadRepoRegistry();
    expect(findRepo(reg, 'chalbert/web-everything')?.slug).toBe('web-everything/web-everything');
    expect(findRepo(reg, 'chalbert/frontierui')?.slug).toBe('frontier-ui/frontierui');
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
