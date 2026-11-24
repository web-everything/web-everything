// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const { jobs } = yaml.load(readFileSync(
  new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8',
));
const fuiJobs = ['standards', 'test-shard', 'integration-part', 'smoke'];
const lightGuard = "needs.changes.outputs.light != 'true'";
const integrationGuard = "steps.gate.outputs.run == 'true'";
const paths = (value) => String(value ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
const mainHistoryPath = '${{ runner.temp }}/main-history';
const mainHistoryKey = 'main-history-v1-${{ github.run_id }}';
const mainPushGuard = "${{ github.ref == 'refs/heads/main' && github.event_name == 'push' }}";
const mainHistoryJobs = ['standards', 'test-shard', 'integration-part', 'daemon-soak-scope', 'soak-shard'];

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
        : name === 'integration-part' ? integrationGuard : lightGuard;
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
      : name === 'integration-part' ? integrationGuard : lightGuard;
    expect(install.if?.replace(/^\$\{\{\s*|\s*\}\}$/g, '').trim()).toBe(guard);
  });

  it('fails closed on missing or unreviewed cache paths, including broad parent directories and globs', () => {
    for (const [name, job] of Object.entries(jobs)) {
      for (const cache of (job.steps ?? []).filter((s) => s.uses?.startsWith('actions/cache'))) {
        const cachedPaths = paths(cache.with?.path);
        expect(cachedPaths.length, `${name}: cache paths must be explicit`).toBeGreaterThan(0);
        for (const path of cachedPaths) {
          // Only browser bundles and the public main commit/tree pack are reviewed payloads.
          // Exact entries reject private directories, parents, other expressions and globs.
          expect(['~/.cache/ms-playwright', mainHistoryPath], `${name}: unreviewed cache payload`).toContain(path);
        }
      }
    }
  });

  it('limits main history caching to five restores and one main-push-only export and upload', () => {
    const mirrors = Object.entries(jobs).flatMap(([name, job]) =>
      (job.steps ?? []).filter((s) => s.uses?.startsWith('actions/cache') && paths(s.with?.path).includes(mainHistoryPath))
        .map((cache) => ({ name, cache })),
    );
    const restores = mirrors.filter(({ cache }) => cache.uses === 'actions/cache/restore@v4');
    const uploads = mirrors.filter(({ cache }) => cache.uses === 'actions/cache/save@v4');
    expect(mirrors).toHaveLength(6);
    expect(restores.map(({ name }) => name).sort()).toEqual([...mainHistoryJobs].sort());
    expect(uploads.map(({ name }) => name)).toEqual(['standards']);
    for (const { cache } of mirrors) {
      expect(paths(cache.with.path)).toEqual([mainHistoryPath]);
      expect(cache.with.key).toBe(mainHistoryKey);
    }
    for (const { name, cache } of restores) {
      expect(cache.with['restore-keys']).toBe('main-history-v1-');
      const steps = jobs[name].steps;
      const checkout = steps[steps.indexOf(cache) + 1];
      const fetch = steps[steps.indexOf(cache) + 2];
      expect(checkout.uses).toBe('actions/checkout@v4');
      expect(checkout.with['fetch-depth']).toBe(50);
      expect(cache.if).toBe(checkout.if);
      expect(fetch.name).toBe('Fetch main history (blobless)');
      expect(fetch.env.MAIN_HISTORY_CACHE_DIR).toBe(mainHistoryPath);
    }
    const exportStep = step('standards', (s) => s.name === 'Save main history mirror');
    const upload = uploads[0].cache;
    expect(exportStep.run).toBe('sh scripts/ci/fetch-main-history.sh save');
    expect(exportStep['working-directory']).toBe('web-everything');
    expect(exportStep.env.MAIN_HISTORY_CACHE_DIR).toBe(mainHistoryPath);
    expect(exportStep.if).toBe(mainPushGuard);
    expect(exportStep).not.toHaveProperty('continue-on-error');
    expect(upload.if).toBe(mainPushGuard);
    expect(jobs.standards.steps.indexOf(upload)).toBe(jobs.standards.steps.indexOf(exportStep) + 1);
  });

  it('smoke no longer caches Playwright browsers: the pinned container ships them', () => {
    const steps = jobs.smoke.steps;
    expect(steps.filter((s) => s.name === 'Cache Playwright browsers')).toHaveLength(0);
    expect(steps.filter((s) => s.name === 'Install Playwright chromium')).toHaveLength(0);
    expect(jobs.smoke.container.image).toMatch(/^mcr\.microsoft\.com\/playwright:v\d+\.\d+\.\d+-jammy$/);
  });

  it('never suppresses cache failures with continue-on-error', () => {
    for (const [name, job] of Object.entries(jobs)) {
      for (const cache of (job.steps ?? []).filter((s) => s.uses?.startsWith('actions/cache'))) {
        expect(cache, `${name}: cache failures must remain visible`).not.toHaveProperty('continue-on-error');
      }
    }
  });
});
