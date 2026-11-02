// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const { jobs } = yaml.load(readFileSync(
  new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8',
));
const fuiJobs = ['standards', 'test-shard', 'integration', 'smoke'];
const lightGuard = "needs.changes.outputs.light != 'true'";
const integrationGuard = "steps.gate.outputs.run == 'true'";
const paths = (value) => String(value ?? '').split('\n').map((line) => line.trim()).filter(Boolean);

function step(name, predicate) {
  const matches = jobs[name].steps.filter(predicate);
  expect(matches, `${name}: exactly one matching step`).toHaveLength(1);
  return matches[0];
}

describe('ci.yml caches beyond the npm download cache', () => {
  describe.each(fuiJobs)('%s FUI tools cache', (name) => {
    it('resolves the checked-out FUI HEAD into the sha output after sibling checkout', () => {
      const checkout = step(name, (s) => s.name === 'Checkout FUI (sibling)');
      const sha = step(name, (s) => s.id === 'fui-sha');
      expect(sha.run).toMatch(/git\s+-C\s+frontierui\s+rev-parse\s+HEAD\b/);
      expect(sha.run).toMatch(/echo\s+["']?sha=/);
      expect(sha.run).toMatch(/>>\s*["']?\$\{?GITHUB_OUTPUT\}?/);
      expect(jobs[name].steps.indexOf(sha)).toBeGreaterThan(jobs[name].steps.indexOf(checkout));
    });

    it('restores dependencies and tools only with an exact OS, Node 22, lockfile and FUI SHA key', () => {
      const cache = step(name, (s) => s.id === 'fui-tools');
      expect(cache.uses).toBe('actions/cache@v4');
      expect(paths(cache.with?.path)).toEqual(expect.arrayContaining([
        'frontierui/node_modules', 'frontierui/dist/tools',
      ]));
      expect(cache.with.key).toContain('runner.os');
      expect(cache.with.key).toMatch(/(?:^|\D)22(?:\D|$)/);
      expect(cache.with.key).toContain("hashFiles('frontierui/package-lock.json')");
      expect(cache.with.key).toContain('steps.fui-sha.outputs.sha');
      expect(cache.with).not.toHaveProperty('restore-keys');
    });

    it('orders SHA resolution, cache restore and build, and builds only on a cache miss', () => {
      const sha = step(name, (s) => s.id === 'fui-sha');
      const cache = step(name, (s) => s.id === 'fui-tools');
      const build = step(name, (s) => s.name === 'Install + build FUI tools');
      expect(jobs[name].steps.indexOf(cache)).toBeGreaterThan(jobs[name].steps.indexOf(sha));
      expect(jobs[name].steps.indexOf(build)).toBeGreaterThan(jobs[name].steps.indexOf(cache));
      expect(build.if).toContain("steps.fui-tools.outputs.cache-hit != 'true'");
      expect(build['working-directory']).toBe('frontierui');
      expect(build.run).toMatch(/\bnpm ci\b/);
      expect(build.run).toMatch(/\bnpm run build:tools\b/);
      if (name === 'test-shard' || name === 'smoke') expect(build.if).toContain(lightGuard);
      if (name === 'integration') expect(build.if).toContain(integrationGuard);
    });
  });

  describe.each(['test-shard', 'integration'])('%s Vite cache', (name) => {
    it('restores .vite after npm ci, which deletes node_modules', () => {
      const install = step(name, (s) => s.name === 'Install');
      const cache = step(name, (s) => s.id === 'vite-cache');
      expect(cache.uses).toBe('actions/cache@v4');
      expect(paths(cache.with?.path)).toEqual(['web-everything/node_modules/.vite']);
      expect(jobs[name].steps.indexOf(cache)).toBeGreaterThan(jobs[name].steps.indexOf(install));
    });

    it('keys by OS, WE lockfile and commit with a restore prefix that omits the commit', () => {
      const cache = step(name, (s) => s.id === 'vite-cache');
      const key = cache.with?.key;
      expect(key).toContain('runner.os');
      expect(key).toContain("hashFiles('web-everything/package-lock.json')");
      expect(key).toMatch(/\$\{\{\s*github\.sha\s*\}\}$/);
      const prefix = key.replace(/\$\{\{\s*github\.sha\s*\}\}$/, '');
      expect(paths(cache.with['restore-keys'])).toContain(prefix);
      for (const restoreKey of paths(cache.with['restore-keys'])) {
        expect(restoreKey).not.toContain('github.sha');
      }
    });
  });

  it.each(fuiJobs)('%s still runs the WE npm ci install regardless of cache hits', (name) => {
    const install = step(name, (s) => s.name === 'Install');
    expect(install['working-directory']).toBe('web-everything');
    expect(install.run.trim()).toBe('npm ci');
    const guard = name === 'standards' ? undefined
      : name === 'integration' ? integrationGuard : lightGuard;
    expect(install.if?.replace(/^\$\{\{\s*|\s*\}\}$/g, '').trim()).toBe(guard);
  });

  it('fails closed on missing cache paths and refuses wholesale WE node_modules caches everywhere', () => {
    for (const [name, job] of Object.entries(jobs)) {
      for (const cache of (job.steps ?? []).filter((s) => s.uses?.startsWith('actions/cache'))) {
        const cachedPaths = paths(cache.with?.path);
        expect(cachedPaths.length, `${name}: cache paths must be explicit`).toBeGreaterThan(0);
        for (const path of cachedPaths) {
          if (path.includes('node_modules')) {
            expect([
              'frontierui/node_modules',
              'web-everything/node_modules/.vite',
              'node_modules/.vite',
            ], `${name}: forbidden dependency cache ${path}`).toContain(path.replace(/^\.\//, '').replace(/\/$/, ''));
          }
        }
      }
    }
  });

  it('never suppresses cache failures with continue-on-error', () => {
    for (const [name, job] of Object.entries(jobs)) {
      for (const cache of (job.steps ?? []).filter((s) => s.uses?.startsWith('actions/cache'))) {
        expect(cache, `${name}: cache failures must remain visible`).not.toHaveProperty('continue-on-error');
      }
    }
  });
});
