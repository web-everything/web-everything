import { describe, it, expect } from 'vitest';
import { HUMAN_SURFACE_CATEGORIES, normalizeHumanSurfaces, resolveHumanReviewSurfaces, sensitiveSurfaceHits } from '../human-review-surfaces.mjs';
const resolve = (tool, env = {}, platform = null) => resolveHumanReviewSurfaces({ env, platform, readFile: () => JSON.stringify({ humanReviewSurfaces: tool }) });
const hits = (file, hunks = '', config = 'narrow') => sensitiveSurfaceHits([file], () => hunks, normalizeHumanSurfaces(config));
describe('human surface cascade', () => {
  it('defaults to narrow at the standard layer', () => expect(resolve(undefined)).toEqual({ categories: HUMAN_SURFACE_CATEGORIES.slice(0, 5), preset: 'narrow', source: 'standard' }));
  it('resolves tool and env and ignores invalid layers', () => {
    expect(resolve('broad').source).toBe('tool');
    expect(resolve('broad', { WE_HUMAN_REVIEW_SURFACES: 'narrow' }).preset).toBe('narrow');
    expect(resolve('bad', { WE_HUMAN_REVIEW_SURFACES: 'bad' }, 'broad')).toMatchObject({ preset: 'broad', source: 'platform' });
    expect(resolve([], {}, 'broad').preset).toBe('broad');
    expect(resolve(['unknown']).source).toBe('standard');
  });
  it('orders custom categories and always restores workflow', () => {
    expect(resolve(['secrets', 'identity']).categories).toEqual(['workflow', 'identity', 'secrets']);
    expect(resolve(undefined, { WE_HUMAN_REVIEW_SURFACES: 'secrets,identity' })).toMatchObject({ categories: ['workflow', 'identity', 'secrets'], source: 'env', preset: 'custom' });
    expect(resolve(undefined, { WE_HUMAN_REVIEW_SURFACES: 'secrets' }).categories).toEqual(['workflow', 'secrets']);
    expect(normalizeHumanSurfaces('broad').source).toBe('explicit');
    expect(normalizeHumanSurfaces(resolve('broad')).source).toBe('explicit');
    for (const bad of ['bad', [], ['bad'], null]) expect(() => normalizeHumanSurfaces(bad)).toThrow();
  });
  it('survives unreadable settings', () => expect(resolveHumanReviewSurfaces({ env: {}, readFile: () => { throw Error('unreadable'); } }).preset).toBe('narrow'));
});
describe('sensitive classifiers', () => {
  it.each([
    ['.github/workflows/x.yml', 'workflow-edit'], ['.github/actions/x/action.yml', 'workflow-edit'],
    ['CODEOWNERS', 'protection'], ['scripts/rulesets/main.json', 'protection'], ['.github/rulesets/main.json', 'protection'],
    ['.github/settings.yml', 'protection'], ['.github/branch-protection.json', 'protection'], ['scripts/lib/required-status-checks.mjs', 'protection'], ['scripts/lib/we-only-checks.json', 'protection'],
    ['scripts/lib/github-app-token.mjs', 'identity'], ['scripts/lib/gh-app-shim.mjs', 'identity'],
    ['scripts/lib/github-auth-policy.mjs', 'identity'], ['scripts/settings/github-auth.json', 'identity'], ['scripts/settings/delivery-identity.json', 'identity'],
    ['scripts/conveyor/credential-inventory.mjs', 'identity'], ['scripts/lib/secret-scrub.mjs', 'identity'],
    ['scripts/lib/usage-report-secret-paths.mjs', 'identity'], ['bin/gh-shim/run.sh', 'identity'],
    ['.env', 'secrets'], ['app/.env.production', 'secrets'], ['cert.pem', 'secrets'], ['cert.key', 'secrets'], ['cert.p12', 'secrets'], ['cert.pfx', 'secrets'], ['id_rsa.pub', 'secrets'], ['id_ed25519', 'secrets'], ['app/secrets/token', 'secrets'], ['.secrets/token', 'secrets'],
  ])('%s requires %s', (file, kind) => expect(hits(file)).toContainEqual(expect.objectContaining({ file, kind })));
  it.each(['scripts/lib/__tests__/github-app-identity.test.mjs', 'scripts/lib/github-app-token.test.mjs', 'bin/gh-shim/readme.md', 'scripts/conveyor/health-smells/gh-shim-lane-path.mjs', 'scripts/conveyor/soak/gh-shim-probe.mjs', 'scripts/rulesets/__tests__/rule.test.mjs', '.env.example', '.env.sample', '.env.template'])('%s is excluded', (file) => expect(hits(file)).toEqual([]));
  it('retains the existing permission detector', () => expect(hits('scripts/example.mjs', '@@ -1 +1 @@\n-sandbox_mode = "read-only"\n+sandbox_mode = "workspace-write"')).toContainEqual(expect.objectContaining({ category: 'permission' })));
  it('self-protects regardless of category selection using only own hunks', () => {
    for (const file of ['scripts/lib/human-review-surfaces.mjs', 'scripts/settings/human-review-surfaces.json']) expect(hits(file, '', ['workflow'])[0].kind).toBe('human-surface-setting');
    for (const file of ['scripts/lib/delivery-platform-preferences.json', 'scripts/lib/delivery-priority-settings.json']) {
      expect(hits(file, null, ['workflow'])[0].kind).toBe('human-surface-setting');
      expect(hits(file, '@@ -1 +1 @@\n+"humanReviewSurfaces": "narrow"', ['workflow'])[0].kind).toBe('human-surface-setting');
      expect(hits(file, '@@ -1 +1 @@\n+"unrelated": true', ['workflow'])).toEqual([]);
    }
  });
});
