// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

const raw = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const { jobs } = yaml.load(raw);
const required = ['changes', 'test-shard', 'integration', 'standards', 'coverage-merge', 'host-paths'];

function runGate({ light = 'false', results = {} } = {}) {
  const values = Object.fromEntries(required.map((name) => [`needs.${name}.result`, results[name] ?? 'success']));
  values['needs.changes.outputs.light'] = light;
  const step = jobs.test.steps.find((s) => s.run);
  expect(step).toBeDefined();
  const script = step.run.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, expr) => {
    if (!(expr in values)) throw new Error(`Unmodelled gate expression: ${expr}`);
    return values[expr];
  });
  const r = spawnSync('bash', ['-e', '-c', script], { encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024 });
  expect(r.error).toBeUndefined();
  return r.status;
}

describe('ci.yml lightweight required test gate', () => {
  it('keeps the test status name, all dependencies, and !cancelled guard', () => {
    expect(jobs.test.name ?? 'test').toBe('test');
    expect([...jobs.test.needs].sort()).toEqual([...required].sort());
    expect(jobs.test.if).toBe('${{ !cancelled() }}');
  });

  it('has only one shell gate, with no checkout, setup-node, install, or FUI work', () => {
    expect(jobs.test.steps).toHaveLength(1);
    const [step] = jobs.test.steps;
    expect(step.uses).toBeUndefined();
    expect(step.run).toBeTypeOf('string');
    expect(JSON.stringify(jobs.test)).not.toMatch(/actions\/(?:checkout|setup-node)|npm ci|frontierui|coverage:merge|check:standards|lint-host-paths/);
    for (const name of required) expect(step.run).toContain(`needs.${name}.result`);
  });

  it('accepts a full run only when every required job succeeded', () => {
    expect(runGate()).toBe(0);
  });

  describe.each(required)('%s result fails closed', (name) => {
    it.each(['failure', 'skipped', 'cancelled', '', 'unknown'])('rejects %j on a full run', (result) => {
      expect(runGate({ results: { [name]: result } })).not.toBe(0);
    });
  });

  it('accepts light runs with skipped shards and coverage merge', () => {
    expect(runGate({ light: 'true', results: { 'test-shard': 'skipped', 'coverage-merge': 'skipped' } })).toBe(0);
  });

  describe.each(['changes', 'integration', 'standards', 'host-paths'])('%s remains required on light runs', (name) => {
    it.each(['failure', 'skipped', 'cancelled', '', 'unknown'])('rejects %j before any light-path early return', (result) => {
      expect(runGate({ light: 'true', results: { [name]: result, 'test-shard': 'skipped', 'coverage-merge': 'skipped' } })).not.toBe(0);
    });
  });

  it.each(['', 'false', 'unknown'])('light=%j does not excuse skipped shards or missing coverage', (light) => {
    for (const name of ['test-shard', 'coverage-merge']) expect(runGate({ light, results: { [name]: 'skipped' } })).not.toBe(0);
  });
});

describe('ci.yml parallel coverage merge and host-path jobs', () => {
  it('uses ten unit groups, nine coverage shards, and eight soak shards', () => {
    expect(jobs['test-shard'].strategy.matrix.shard).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(jobs['soak-shard'].strategy.matrix.shard).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const steps = jobs['test-shard'].steps;
    const covered = steps.find((s) => s.name?.startsWith('Unit suite shard'));
    const nocov = steps.find((s) => s.name?.startsWith('Unit suite no-coverage group'));
    const count = jobs['test-shard'].strategy.matrix.shard.length - 1;
    expect(covered.name).toContain(`\${{ matrix.shard }}/${count}`);
    expect(covered.run).toContain(`--shard=\${{ matrix.shard }}/${count}`);
    expect(covered.if).toMatch(/matrix\.shard != 10\b/);
    expect(nocov.if).toMatch(/matrix\.shard == 10\b/);
    expect(nocov.run).toContain('--group=nocov --shard=1/1');
    expect(JSON.stringify(steps)).not.toMatch(/matrix\.shard\s*(?:==|!=)\s*5\b/);
    const merge = jobs['coverage-merge'];
    expect(merge).toBeDefined();
    const command = merge.steps.find((s) => s.run?.includes('coverage:merge')).run;
    expect(command).toContain(`--expect=${count}`);
    expect(command).toContain('coverage-shards --threshold=80');
  });

  it('merges only after successful full-run shards, using npm without FUI', () => {
    const merge = jobs['coverage-merge'];
    expect(merge).toBeDefined();
    expect([...merge.needs].sort()).toEqual(['changes', 'test-shard']);
    expect(merge.if).toBe("${{ !cancelled() && needs.changes.outputs.light != 'true' }}");
    expect(merge.steps.some((s) => s.run?.includes('needs.test-shard.result') && s.run.includes('success') && /exit [12]/.test(s.run))).toBe(true);
    const checkout = merge.steps.find((s) => s.uses?.startsWith('actions/checkout@'));
    expect(checkout).toBeDefined();
    expect(checkout.with?.['fetch-depth'] ?? 1).toBe(1);
    const setup = merge.steps.find((s) => s.uses?.startsWith('actions/setup-node@'));
    expect(setup.with['node-version']).toBe(22);
    expect(setup.with.cache).toBe('npm');
    expect(merge.steps.some((s) => s.run === 'npm ci' && s['working-directory'] === 'web-everything')).toBe(true);
    expect(JSON.stringify(merge)).not.toMatch(/frontierui|build:tools/);
    const download = merge.steps.find((s) => s.uses?.startsWith('actions/download-artifact@'));
    expect(download.with).toMatchObject({ pattern: 'coverage-shard-*', path: 'web-everything/coverage-shards' });
  });

  it('runs host-path checks independently with a shallow checkout', () => {
    const host = jobs['host-paths'];
    expect(host).toBeDefined();
    expect(host.needs).toBeUndefined();
    const checkout = host.steps.find((s) => s.uses?.startsWith('actions/checkout@'));
    expect(checkout).toBeDefined();
    expect(checkout.with?.['fetch-depth'] ?? 1).toBe(1);
    expect(host.steps.some((s) => s.run?.includes('node scripts/lint-host-paths.mjs'))).toBe(true);
    expect(jobs.standards.steps.some((s) => s.run?.includes('npm run check:standards'))).toBe(true);
  });
});
