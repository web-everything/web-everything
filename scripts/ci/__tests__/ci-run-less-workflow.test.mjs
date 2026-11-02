// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';

const workflow = yaml.load(readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'));
const { jobs } = workflow;

describe('ci.yml queue-tested push relief and nightly full-run backstop', () => {
  it('has exactly one cron entry for the nightly full-run backstop', () => {
    expect(workflow.on.schedule).toEqual([{ cron: expect.any(String) }]);
    expect(workflow.on.schedule[0].cron.trim()).not.toBe('');
  });

  it('lets changes read Actions run evidence', () => {
    expect(jobs.changes.permissions).toMatchObject({ actions: 'read' });
  });

  it('runs the queue detector in a continue-on-error step so failures retain full CI', () => {
    const queue = jobs.changes.steps.find((step) => step.id === 'queue');
    expect(queue).toBeDefined();
    expect(queue.run).toMatch(/\bnode\s+scripts\/ci\/skip-queue-tested-push\.mjs\b/);
    expect(queue['continue-on-error']).toBe(true);
  });

  it('combines queue-tested and card-only evidence into the light job output', () => {
    const light = jobs.changes.outputs.light;
    expect(light).toMatch(/^\$\{\{[\s\S]*\}\}$/);
    expect(light).toContain('steps.queue.outputs.queue_tested');
    expect(light).toContain('steps.detect.outputs.light');
    expect(light).toContain('true');
  });

  it('makes soak scope depend on changes so it can consume queue-tested light output', () => {
    const needs = jobs['daemon-soak-scope'].needs;
    expect(Array.isArray(needs) ? needs : [needs]).toContain('changes');
  });

  it.each(['daemon-soak-scope', 'daemon-soak'])('includes scheduled events in %s admission', (name) => {
    expect(jobs[name].if).toContain('schedule');
  });

  it('reads light evidence in the scope step and explicitly guards the run=false shortcut by push event', () => {
    const scope = jobs['daemon-soak-scope'].steps.find((step) => step.id === 'scope');
    expect(scope).toBeDefined();
    const evidence = `${JSON.stringify(scope.env ?? {})}\n${scope.run}`;
    expect(evidence).toContain('needs.changes.outputs.light');
    expect(scope.run).toMatch(/\bpush\b/);
    expect(scope.run).toContain('run=false');
  });

  it.each(['test', 'smoke', 'daemon-soak'])('keeps required check %s running rather than job-skipping on light', (name) => {
    expect(jobs[name]).toBeDefined();
    if (jobs[name].if !== undefined) expect(jobs[name].if).not.toContain('light');
  });
});
