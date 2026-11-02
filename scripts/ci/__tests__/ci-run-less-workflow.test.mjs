// @vitest-environment node
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { SIBLING_REPO } from '../skip-queue-tested-push.mjs';

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

  it('has exactly one daily 06:17 UTC cron entry for the nightly full-run backstop', () => {
    expect(workflow.on.schedule).toEqual([{ cron: '17 6 * * *' }]);
  });

  it('lets changes read Actions run evidence', () => {
    expect(jobs.changes.permissions).toMatchObject({ actions: 'read' });
  });

  it('wires the queue detector token, quoted event inputs and output in a continue-on-error step', () => {
    const queue = jobs.changes.steps.find((step) => step.id === 'queue');
    expect(queue).toBeDefined();
    expect(queue.env).toEqual({
      GH_TOKEN: '${{ github.token }}',
      EVENT_NAME: '${{ github.event_name }}',
      REF: '${{ github.ref }}',
      SHA: '${{ github.sha }}',
      REPO: '${{ github.repository }}',
      FUI_TOKEN: "${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && (steps.fui-app-token.outputs.token || secrets.FUI_READ_TOKEN) || '' }}",
    });
    expect(queue.run).toBe('node scripts/ci/skip-queue-tested-push.mjs --event="$EVENT_NAME" --ref="$REF" --sha="$SHA" --repo="$REPO" >> "$GITHUB_OUTPUT"');
    expect(queue['continue-on-error']).toBe(true);
  });

  it.each([
    ['push', 'refs/heads/main', 'app', '', 'app'],
    ['push', 'refs/heads/main', '', 'pat', 'pat'],
    ['push', 'refs/heads/main', '', '', ''],
    ['push', 'refs/heads/feature', 'app', 'pat', ''],
    ['pull_request', 'refs/pull/1/merge', 'app', 'pat', ''],
    ['merge_group', 'refs/heads/gh-readonly-queue/main/pr-1', 'app', 'pat', ''],
    ['schedule', 'refs/heads/main', 'app', 'pat', ''],
  ])('passes the FUI token on %s %s only for push to main (app=%j pat=%j → %j)', (event, ref, app, pat, expected) => {
    const source = jobs.changes.steps.find((step) => step.id === 'queue').env.FUI_TOKEN.match(/^\$\{\{([\s\S]*)\}\}$/)[1]
      .replaceAll('github.event_name', JSON.stringify(event)).replaceAll('github.ref', JSON.stringify(ref))
      .replaceAll('steps.fui-app-token.outputs.token', JSON.stringify(app))
      .replaceAll('secrets.FUI_READ_TOKEN', JSON.stringify(pat));
    expect(source.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '')).toMatch(/^[\s=&|()]*$/);
    expect(runInNewContext(source.replace(/'/g, '"'))).toBe(expected);
  });

  it('mints the FUI read token only on push to main, fail-soft, before the queue step', () => {
    const steps = jobs.changes.steps;
    const mint = steps.find((step) => step.id === 'fui-app-token');
    expect(mint.uses).toBe('actions/create-github-app-token@v2');
    expect(mint.if).toBe("${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && vars.WE_APP_ID != '' }}");
    expect(mint['continue-on-error']).toBe(true);
    // Both fail-soft steps together stay inside the changes job's timeout.
    const queue = steps.find((step) => step.id === 'queue');
    expect(mint['timeout-minutes']).toBe(1);
    expect(mint['timeout-minutes'] + queue['timeout-minutes']).toBeLessThan(jobs.changes['timeout-minutes']);
    expect(mint.with).toMatchObject({ owner: 'frontier-ui', repositories: 'frontierui', 'permission-contents': 'read' });
    expect(steps.indexOf(mint)).toBeLessThan(steps.indexOf(steps.find((step) => step.id === 'queue')));
  });

  it('every frontierui checkout is the unpinned default-branch tip the queue detector proves unchanged', () => {
    const checkouts = Object.values(jobs).flatMap((job) => job.steps ?? [])
      .filter((step) => String(step.uses).startsWith('actions/checkout@') && step.with?.repository);
    expect(checkouts.length).toBeGreaterThan(0);
    for (const step of checkouts) {
      expect(step.with.repository).toBe(SIBLING_REPO);
      expect(step.with.ref).toBeUndefined();
    }
  });

  it('bounds the queue step below the changes job timeout and keeps the git credentials its ops/quarantine fetch needs', () => {
    const queue = jobs.changes.steps.find((step) => step.id === 'queue');
    expect(queue['timeout-minutes']).toBe(3);
    expect(queue['timeout-minutes']).toBeLessThan(jobs.changes['timeout-minutes']);
    const checkout = jobs.changes.steps.find((step) => String(step.uses).startsWith('actions/checkout@'));
    expect(jobs.changes.steps.indexOf(checkout)).toBeLessThan(jobs.changes.steps.indexOf(queue));
    expect(checkout.with?.['persist-credentials']).not.toBe(false);
    expect(jobs.changes.permissions).toEqual({ contents: 'read', actions: 'read' });
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
