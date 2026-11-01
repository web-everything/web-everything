// @vitest-environment node
// #5027 — pins the Arm-runner experiment switch in ci.yml: ONLY `test-shard` reads `vars.WE_SHARD_RUNNER`
// (falling back to x86), smoke pins a Playwright-supported OS, and the matrix stays single-axis so
// the coverage divisor remains matrix length minus the no-coverage group.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const raw = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const jobs = yaml.load(raw).jobs;

describe('ci.yml test-shard runner switch (#5027)', () => {
  it('test-shard runs on vars.WE_SHARD_RUNNER with an ubuntu-latest fallback', () => {
    expect(jobs['test-shard']['runs-on']).toMatch(/^\$\{\{\s*vars\.WE_SHARD_RUNNER\s*\|\|\s*'ubuntu-latest'\s*\}\}$/);
  });

  it('exactly one job (test-shard) reads WE_SHARD_RUNNER', () => {
    const readers = Object.entries(jobs).filter(([, j]) => JSON.stringify(j['runs-on'] ?? '').includes('WE_SHARD_RUNNER')).map(([n]) => n);
    expect(readers).toEqual(['test-shard']);
    expect(raw.split('\n').filter((l) => /^ {4}runs-on: .*vars\.WE_SHARD_RUNNER/.test(l))).toHaveLength(1);
  });

  it('smoke pins Ubuntu 24.04 and retains browser dependency installation and interaction tests', () => {
    expect(jobs.smoke['runs-on']).toBe('ubuntu-24.04');
    expect(jobs.smoke.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ run: 'npx playwright install --with-deps chromium' }),
      expect.objectContaining({ run: 'npm run test:interaction', env: { WE_INTERACTION_ONLY: '1' } }),
    ]));
  });

  it('other jobs stay on ubuntu-latest (the Arm switch must not widen)', () => {
    for (const [name, j] of Object.entries(jobs)) {
      if (name === 'test-shard' || name === 'smoke') continue;
      expect(j['runs-on'], `${name} must not follow the Arm switch`).toBe('ubuntu-latest');
    }
    for (const name of ['test', 'changes', 'daemon-soak-scope', 'soak-shard']) expect(jobs[name]).toBeDefined();
  });

  it('keeps ten shards on a single matrix axis, with nine coverage shards', () => {
    const matrix = jobs['test-shard'].strategy.matrix;
    expect(Object.keys(matrix)).toEqual(['shard']);
    expect(matrix.shard).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});
