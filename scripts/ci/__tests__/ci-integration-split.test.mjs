// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import config from '../../../vitest.integration.config';
import { integrationFilesForGroup, integrationGroup, integrationGroups } from '../integration-groups.mjs';

const { jobs } = yaml.load(readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'));
const files = config.test.include;
const parts = jobs['integration-part'];

function runGate(changes, part) {
  const values = { 'needs.changes.result': changes, 'needs.integration-part.result': part };
  const script = jobs.integration.steps[0].run.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, expression) => {
    if (!(expression in values)) throw new Error(`Unexpected expression: ${expression}`);
    return values[expression];
  });
  const result = spawnSync('bash', ['-e', '-c', script], { encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024 });
  expect(result.error).toBeUndefined();
  return result.status;
}

describe('TT3 integration inventory', () => {
  it('partitions the full config include list exactly once with no empty group', () => {
    expect(files.length).toBeGreaterThan(0);
    const groups = integrationGroups.map((group) => integrationFilesForGroup(files, group));
    for (const group of groups) expect(group.length).toBeGreaterThan(0);
    expect(groups.flat().sort()).toEqual([...files].sort());
    expect(new Set(groups.flat()).size).toBe(files.length);
    expect(integrationFilesForGroup(files)).toEqual(files);
  });

  it('keeps all six scan-chain files together', () => {
    expect(integrationFilesForGroup(files, 'scan-chain').map((file) => file.split('/').at(-1)).sort()).toEqual([
      'gate-entrypoint-integration.test.mjs', 'rust-scan-citation-check-parity.test.mjs',
      'rust-scan-locus-prefix-parity.test.mjs', 'rust-scan-secret-scrub-parity.test.mjs',
      'rust-scan-stdout-flush-parity.test.mjs', 'stdout-flush.test.mjs',
    ]);
  });

  it('keeps scenario/world and every forks-pinned sim file together, with other non-lane-pool files parallel', () => {
    for (const file of files) {
      const name = file.split('/').at(-1);
      if (name.startsWith('sim-')) expect(integrationGroup(file)).toBe('sim-scenarios');
      else if (name.startsWith('lane-pool-')) expect(['lane-pool-a', 'lane-pool-b']).toContain(integrationGroup(file));
      else if (!/^(stdout-flush|rust-scan-|gate-entrypoint)/.test(name)) expect(integrationGroup(file)).toBe('parallel');
    }
    for (const [file, pool] of config.test.poolMatchGlobs) {
      if (pool === 'forks' && /\/(?:sim-|fake-)/.test(file)) expect(integrationGroup(file)).toBe('sim-scenarios');
    }
    expect(config.test.pool).toBe('threads');
    expect(config.test.poolOptions.forks.singleFork).toBe(true);
  });

  it('assigns every current lane-pool file to exactly one of two non-empty lane-pool groups', () => {
    const laneFiles = files.filter((file) => file.split('/').at(-1).startsWith('lane-pool-'));
    const groups = ['lane-pool-a', 'lane-pool-b'].map((group) => integrationFilesForGroup(files, group));
    for (const group of groups) expect(group.length).toBeGreaterThan(0);
    expect(groups.flat().sort()).toEqual([...laneFiles].sort());
    for (const file of laneFiles) {
      expect(integrationGroups.filter((group) => integrationFilesForGroup([file], group).length)).toEqual([integrationGroup(file)]);
    }
  });

  it.each([
    ['lane-pool-acquire-base.test.mjs', 'lane-pool-a'],
    ['lane-pool-future-a.test.mjs', 'lane-pool-b'],
    ['lane-pool-future-b.test.mjs', 'lane-pool-a'],
  ])('stably hashes basename %s independent of directory and inventory order', (name, expected) => {
    const paths = [name, `scripts/__tests__/${name}`, `other/directory/${name}`];
    for (const file of paths) expect(integrationGroup(file)).toBe(expected);
    expect(integrationFilesForGroup([...files, ...paths], expected)).toContain(paths[0]);
    expect(integrationFilesForGroup([...paths, ...files].reverse(), expected).reverse())
      .toEqual(integrationFilesForGroup([...paths, ...files], expected));
  });

  it.each(['', 'unknown', 'SCAN-CHAIN'])('rejects unknown group %j with an actionable fallback', (group) => {
    expect(() => integrationFilesForGroup(files, group)).toThrow(/Unknown WE_INTEGRATION_GROUP:.*unset it for all files/);
  });

  it.each(integrationGroups)('wires WE_INTEGRATION_GROUP=%s into the actual config', async (group) => {
    vi.stubEnv('WE_INTEGRATION_GROUP', group);
    vi.resetModules();
    try {
      const { default: selected } = await import('../../../vitest.integration.config');
      expect(selected.test.include).toEqual(integrationFilesForGroup(files, group));
      expect(selected.test.poolMatchGlobs).toEqual(config.test.poolMatchGlobs);
      expect(selected.test.poolOptions).toEqual(config.test.poolOptions);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('TT3 CI integration gate', () => {
  it('retains the required name and always runs, even after cancellation or skips', () => {
    expect(jobs.integration.name ?? 'integration').toBe('integration');
    expect(jobs.integration.needs).toEqual(['changes', 'integration-part']);
    expect(jobs.integration.if).toBe('${{ always() }}');
    expect(jobs.integration['timeout-minutes']).toBe(5);
    expect(jobs.integration.steps).toHaveLength(1);
  });

  it.each(['failure', 'cancelled', 'skipped', 'timed_out', '', 'unknown'])('fails closed when a part result is %j', (result) => {
    expect(runGate('success', result)).toBe(1);
  });

  it.each(['failure', 'cancelled', 'skipped', 'timed_out', '', 'unknown'])('fails closed when changes result is %j', (result) => {
    expect(runGate(result, 'success')).toBe(1);
  });

  it('succeeds only with successful changes and parts (including card-only success)', () => {
    expect(runGate('success', 'success')).toBe(0);
  });

  it('runs exactly five independent groups with at least 1.6x timeout headroom', () => {
    expect(parts.strategy['fail-fast']).toBe(false);
    expect(integrationGroups).toEqual(['scan-chain', 'sim-scenarios', 'lane-pool-a', 'lane-pool-b', 'parallel']);
    expect(parts.strategy.matrix.group).toEqual(integrationGroups);
    expect(parts.strategy.matrix.include.map((entry) => entry.group)).toEqual(integrationGroups);
    expect(parts['timeout-minutes']).toBe('${{ matrix.timeout }}');
    for (const entry of parts.strategy.matrix.include) expect(entry.timeout).toBeGreaterThanOrEqual(16);
    for (const entry of parts.strategy.matrix.include.filter((entry) => entry.group.startsWith('lane-pool-'))) {
      expect(entry.timeout).toBe(20);
    }
    expect(parts.needs).toBe('changes');
    const step = parts.steps.find((step) => step.run?.includes('npm run test:integration:vitest'));
    expect(step.env.WE_INTEGRATION_GROUP).toBe('${{ matrix.group }}');
    expect(step.run).toContain('--job="integration"');
    expect(step.if).toBe("${{ steps.gate.outputs.run == 'true' }}");
  });
});
