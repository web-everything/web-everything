// @vitest-environment node
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';

const workflow = yaml.load(readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'));
const { jobs } = workflow;

describe('ci.yml queue-tested push relief and nightly full-run backstop', () => {
  it('isolates the nightly backstop from pushes while preserving other concurrency groups', () => {
    const groupFor = (event, ref) => workflow.concurrency.group.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, source) => {
      const expression = source
        .replaceAll('github.event_name', JSON.stringify(event))
        .replaceAll('github.ref', JSON.stringify(ref));
      // Evaluate only the string/number/boolean subset used by this group.
      expect(expression.replace(/'[^']*'|"[^"]*"|\d+|==|!=|&&|\|\||[()\s]/g, '')).toBe('');
      return runInNewContext(expression, Object.create(null), { timeout: 100 });
    });
    const main = 'refs/heads/main';
    expect(groupFor('schedule', main)).not.toBe(groupFor('push', main));
    expect(groupFor('push', main)).toBe('ci-refs/heads/main');
    expect(groupFor('pull_request', 'refs/pull/42/merge')).toBe('ci-refs/pull/42/merge');
    expect(groupFor('merge_group', 'refs/heads/gh-readonly-queue/main/pr-42')).toBe('ci-refs/heads/gh-readonly-queue/main/pr-42');
    expect(groupFor('workflow_dispatch', main)).toBe('ci-refs/heads/main');
  });

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

  it.each([
    ['true', 'true', 'true'],
    ['true', 'false', 'true'],
    ['true', '', 'true'],
    ['false', 'true', 'true'],
    ['false', 'false', 'false'],
    ['false', '', ''],
    ['', 'true', 'true'],
    ['', 'false', 'false'],
    ['', '', ''],
  ])('combines queue=%j and card-only=%j into light=%j (missing evidence stays full)', (queue, card, expected) => {
    const light = jobs.changes.outputs.light;
    expect(light).toMatch(/^\$\{\{[\s\S]*\}\}$/);
    expect(light).toContain('steps.queue.outputs.queue_tested');
    expect(light).toContain('steps.detect.outputs.light');
    expect(light).toContain('true');
    // Evaluate the shipped expression, not a copy of its logic. This restricted
    // string/boolean operator subset has the same semantics in Actions and JS;
    // missing Actions outputs resolve to ''. Reject syntax outside that subset.
    const expression = light.slice(3, -2)
      .replaceAll('steps.queue.outputs.queue_tested', JSON.stringify(queue))
      .replaceAll('steps.detect.outputs.light', JSON.stringify(card));
    expect(expression.replace(/'true'|'false'|"true"|"false"|""|==|!=|&&|\|\||[()\s]/g, '')).toBe('');
    const actual = runInNewContext(expression, Object.create(null), { timeout: 100 });
    expect(actual).toBe(expected);
    expect(actual === 'true').toBe(queue === 'true' || card === 'true');
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
