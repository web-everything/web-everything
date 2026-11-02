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
  it('never publishes private FUI code or Vite transforms to fork-readable caches', () => {
    for (const [name, job] of Object.entries(jobs)) {
      for (const cache of (job.steps ?? []).filter((s) => s.uses?.startsWith('actions/cache'))) {
        for (const path of paths(cache.with?.path)) {
          expect(path, `${name}: private source, dependencies and transforms must stay on the runner`)
            .not.toMatch(/frontierui|(?:^|\/)\.vite(?:\/|$)/);
        }
      }
    }
  });

  describe.each(fuiJobs)('%s private FUI tools', (name) => {
    it('installs and builds from the authenticated checkout on every eligible run', () => {
      const checkout = step(name, (s) => s.name === 'Checkout FUI (sibling)');
      const build = step(name, (s) => s.name === 'Install + build FUI tools');
      const install = step(name, (s) => s.name === 'Install');
      expect(checkout.with.repository).toBe('frontier-ui/frontierui');
      expect(checkout.with.token).toContain('steps.fui-app-token.outputs.token');
      expect(checkout.with.token).toContain('secrets.FUI_READ_TOKEN');
      expect(jobs[name].steps.indexOf(build)).toBeGreaterThan(jobs[name].steps.indexOf(checkout));
      expect(jobs[name].steps.indexOf(build)).toBeLessThan(jobs[name].steps.indexOf(install));
      expect(build['working-directory']).toBe('frontierui');
      expect(build.run.trim()).toBe('npm ci\nnpm run build:tools');
      const guard = name === 'standards' ? undefined
        : name === 'integration' ? integrationGuard : lightGuard;
      expect(build.if?.replace(/^\$\{\{\s*|\s*\}\}$/g, '').trim()).toBe(guard);
      expect(build.if).toBe(checkout.if);
    });

    it('retains the npm download cache without caching the private checkout or build output', () => {
      const setup = step(name, (s) => s.uses === 'actions/setup-node@v4');
      expect(setup.with['node-version']).toBe(22);
      expect(setup.with.cache).toBe('npm');
      expect(paths(setup.with['cache-dependency-path'])).toEqual([
        'web-everything/package-lock.json', 'frontierui/package-lock.json',
      ]);
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

  it('fails closed on missing or unreviewed cache paths, including broad parent directories and globs', () => {
    for (const [name, job] of Object.entries(jobs)) {
      for (const cache of (job.steps ?? []).filter((s) => s.uses?.startsWith('actions/cache'))) {
        const cachedPaths = paths(cache.with?.path);
        expect(cachedPaths.length, `${name}: cache paths must be explicit`).toBeGreaterThan(0);
        for (const path of cachedPaths) {
          // The browser bundle is the only reviewed public payload. An allowlist also rejects
          // renamed private directories, workspace parents, expressions and wildcard paths.
          expect(path, `${name}: unreviewed cache payload`).toBe('~/.cache/ms-playwright');
        }
      }
    }
  });

  it('retains the public Playwright browser cache keyed by browser version', () => {
    const cache = step('smoke', (s) => s.name === 'Cache Playwright browsers');
    expect(cache.uses).toBe('actions/cache@v4');
    expect(paths(cache.with?.path)).toEqual(['~/.cache/ms-playwright']);
    expect(cache.with.key).toBe('playwright-${{ runner.os }}-${{ steps.pw.outputs.version }}');
  });

  it('never suppresses cache failures with continue-on-error', () => {
    for (const [name, job] of Object.entries(jobs)) {
      for (const cache of (job.steps ?? []).filter((s) => s.uses?.startsWith('actions/cache'))) {
        expect(cache, `${name}: cache failures must remain visible`).not.toHaveProperty('continue-on-error');
      }
    }
  });
});
