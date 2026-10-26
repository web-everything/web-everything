// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import yaml from 'js-yaml';

const raw = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const { jobs } = yaml.load(raw);

// Read inside each test: a missing/unreadable/invalid workflow must fail assertions,
// rather than preventing Vitest from collecting the other acceptance tests.
function hetznerWorkflow() {
  const text = readFileSync(new URL('../../../.github/workflows/hetzner-jobs.yml', import.meta.url), 'utf8');
  const workflow = yaml.load(text);
  expect(workflow?.jobs).toBeTypeOf('object');
  return { text, ...workflow };
}

const dependencies = (job) => Array.isArray(job.needs) ? job.needs : [job.needs];
const stepsUsing = (job, action) => (job.steps ?? []).filter((s) => s.uses?.startsWith(`${action}@`));

// These job conditions use the shared GitHub/JavaScript boolean-expression subset.
// Unknown context/functions throw, so incomplete routing evidence fails closed.
function routed(job, event, ref = 'refs/heads/main') {
  expect(job.if).toBeTypeOf('string');
  const expression = job.if.trim().replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  const result = runInNewContext(expression, {
    github: { event_name: event, ref },
    needs: { changes: { result: 'success', outputs: { light: 'false' } } },
    cancelled: () => false,
    success: () => true,
    always: () => true,
  }, { timeout: 100 });
  expect(result).toBeTypeOf('boolean');
  return result;
}

describe('Hetzner reusable CI workflow contract', () => {
  it('exists and exposes workflow_call only, refusing missing or incomplete workflow evidence', () => {
    const workflow = hetznerWorkflow();
    const triggers = typeof workflow.on === 'string' ? [workflow.on]
      : Array.isArray(workflow.on) ? workflow.on : Object.keys(workflow.on ?? {});
    expect(triggers).toEqual(['workflow_call']);
  });

  it('defines exactly test-shard and integration on the fixed Hetzner labels', () => {
    const workflow = hetznerWorkflow();
    expect(Object.keys(workflow.jobs).sort()).toEqual(['integration', 'test-shard']);
    for (const job of Object.values(workflow.jobs)) {
      expect(job['runs-on']).toEqual(['self-hosted', 'hetzner', 'we']);
    }
    expect(workflow.text).not.toContain('ubuntu-latest');
    expect(workflow.text).not.toContain('vars.WE_SHARD_RUNNER');
  });

  it('uses a single shard dimension containing exactly shards 1 through 10', () => {
    expect(hetznerWorkflow().jobs['test-shard'].strategy.matrix).toEqual({
      shard: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    });
    expect(hetznerWorkflow().jobs.integration.strategy?.matrix).toBeUndefined();
  });

  it.each(['test-shard', 'integration'])('%s pins every WE checkout to github.sha', (name) => {
    const checkouts = stepsUsing(hetznerWorkflow().jobs[name], 'actions/checkout').filter((step) => {
      const repository = step.with?.repository;
      return !repository || repository === '${{ github.repository }}' || /(?:^|\/)web-everything$/i.test(repository);
    });
    expect(checkouts.length).toBeGreaterThan(0);
    for (const checkout of checkouts) expect(checkout.with?.ref).toBe('${{ github.sha }}');
  });

  it('uploads the coverage and timing artifact names consumed by the caller', () => {
    const uploads = stepsUsing(hetznerWorkflow().jobs['test-shard'], 'actions/upload-artifact');
    const names = uploads.map((step) => step.with?.name);
    expect(names).toContain('coverage-shard-${{ matrix.shard }}');
    expect(names).toContain('timing-unit-${{ matrix.shard }}');
    const downloads = stepsUsing(jobs['coverage-merge'], 'actions/download-artifact');
    expect(downloads.some((step) => step.with?.pattern === 'coverage-shard-*')).toBe(true);
  });
});

describe('ci.yml routes trusted events to Hetzner and preserves hosted PR checks', () => {
  it('calls the local workflow at the tested commit, inherits secrets and waits for changes', () => {
    expect(jobs.hetzner).toBeDefined();
    expect(jobs.hetzner.uses).toBe('./.github/workflows/hetzner-jobs.yml');
    expect(jobs.hetzner.secrets).toBe('inherit');
    expect(dependencies(jobs.hetzner)).toContain('changes');
    // Keep the rationale next to the caller, including why @main is inappropriate.
    const caller = raw.match(/(?:^ *#.*\n)*^  hetzner:\n[\s\S]*?(?=^  [\w-]+:|$(?![\s\S]))/m)?.[0];
    expect(caller).toBeDefined();
    const comments = caller.split('\n').filter((line) => /^\s*#/.test(line)).join('\n');
    expect(comments).toContain('@main');
    expect(comments).toMatch(/commit|sha|revision|tested|same ref/i);
  });

  it('routes only merge_group and pushes to main to Hetzner', () => {
    expect(jobs.hetzner).toBeDefined();
    expect(jobs.hetzner.if).toContain('merge_group');
    expect(jobs.hetzner.if).toContain('push');
    expect(jobs.hetzner.if).toContain('refs/heads/main');
    expect(routed(jobs.hetzner, 'merge_group', 'refs/heads/gh-readonly-queue/main/pr-1')).toBe(true);
    expect(routed(jobs.hetzner, 'push')).toBe(true);
    for (const event of ['pull_request', 'pull_request_target', 'workflow_dispatch', 'schedule', 'unknown']) {
      expect(routed(jobs.hetzner, event), event).toBe(false);
    }
    expect(routed(jobs.hetzner, 'push', 'refs/heads/feature')).toBe(false);
    expect(routed(jobs.hetzner, 'push', 'refs/tags/v1')).toBe(false);
  });

  it.each(['test-shard', 'integration'])('%s runs only for pull_request/workflow_dispatch on hosted Ubuntu', (name) => {
    const job = jobs[name];
    expect(job.if).toContain('pull_request');
    expect(job.if).toContain('workflow_dispatch');
    for (const event of ['pull_request', 'workflow_dispatch']) expect(routed(job, event), event).toBe(true);
    for (const event of ['merge_group', 'push', 'pull_request_target', 'schedule', 'unknown']) {
      expect(routed(job, event), event).toBe(false);
    }
    if (name === 'test-shard') {
      expect(job['runs-on']).toMatch(/^\$\{\{\s*vars\.WE_SHARD_RUNNER\s*\|\|\s*'ubuntu-latest'\s*\}\}$/);
    } else {
      expect(job['runs-on']).toBe('ubuntu-latest');
    }
  });

  it.each(['test', 'smoke', 'daemon-soak'])('preserves the required %s check id/name on ubuntu-latest only', (name) => {
    expect(jobs[name]).toBeDefined();
    expect(jobs[name].name ?? name).toBe(name);
    expect(jobs[name]['runs-on']).toBe('ubuntu-latest');
    const reusableJobs = hetznerWorkflow().jobs;
    expect(reusableJobs).not.toHaveProperty(name);
    expect(Object.entries(reusableJobs).some(([id, job]) => (job.name ?? id) === name)).toBe(false);
  });

  it.each(['test', 'coverage-merge'])('%s waits for hetzner', (name) => {
    expect(dependencies(jobs[name])).toContain('hetzner');
  });

  it.each(['test', 'coverage-merge'])('%s gates on the effective Hetzner result for merge_group/push', (name) => {
    const gates = jobs[name].steps.filter((step) => step.run?.includes('needs.hetzner.result'));
    expect(gates.length).toBeGreaterThan(0);
    const script = gates.map((step) => step.run).join('\n');
    expect(script).toContain('github.event_name');
    expect(script).toContain('merge_group');
    expect(script).toContain('push');
    expect(script).toContain('needs.test-shard.result');
    expect(script).toContain('success');
    expect(script).toMatch(/exit\s+[1-9]\d*\b/);
  });

  it('keeps all self-hosted routing out of ci.yml, including comments', () => {
    expect(raw).not.toContain('self-hosted');
  });
});
