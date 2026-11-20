// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { resolveFailFast } from '../fail-fast.mjs';

const wf = yaml.load(readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'));
const setting = JSON.stringify({ ci: { failFast: { mergeQueue: true, pullRequest: false } } });

describe('fail-fast follows the per-event setting', () => {
  it('is true for merge_group and false for pull_request and push', () => {
    expect(resolveFailFast('merge_group', setting)).toBe(true);
    expect(resolveFailFast('pull_request', setting)).toBe(false);
    expect(resolveFailFast('push', setting)).toBe(false);
  });
  it('follows the setting values, not a hardcoded event', () => {
    const flipped = JSON.stringify({ ci: { failFast: { mergeQueue: false, pullRequest: true } } });
    expect(resolveFailFast('merge_group', flipped)).toBe(false);
    expect(resolveFailFast('pull_request', flipped)).toBe(true);
  });
  it.each([undefined, '', 'not json', '{}', '{"ci":{"failFast":{"mergeQueue":"yes"}}}'])('unreadable setting %j means no fail-fast', (text) => {
    expect(resolveFailFast('merge_group', text)).toBe(false);
  });
  it('unknown events never fail fast', () => {
    expect(resolveFailFast('workflow_dispatch', setting)).toBe(false);
  });
  it('shipped setting file matches the ruling', () => {
    const real = readFileSync(new URL('../../settings/ci-fail-fast.json', import.meta.url), 'utf8');
    expect(resolveFailFast('merge_group', real)).toBe(true);
    expect(resolveFailFast('pull_request', real)).toBe(false);
  });
  it('wires fail-fast from the changes job output on the unit and integration matrices', () => {
    expect(wf.jobs.changes.outputs.fail_fast).toBeDefined();
    for (const name of ['test-shard', 'integration-part']) {
      expect(wf.jobs[name].needs).toContain('changes');
      expect(wf.jobs[name].strategy['fail-fast']).toBe("${{ needs.changes.outputs.fail_fast == 'true' }}");
    }
  });
  it('required aggregates still fail on a cancelled or failed shard', () => {
    const test = wf.jobs.test.steps[0].run;
    expect(test).toContain('needs.test-shard.result }}" != "success"');
    expect(test).toContain('needs.integration.result }}" != "success"');
    expect(wf.jobs['coverage-merge'].steps[0].run).toContain('needs.test-shard.result }}" != "success"');
    expect(wf.jobs.test.if).toBe('${{ !cancelled() }}');
    expect(wf.jobs['coverage-merge'].if).toContain('!cancelled()');
  });
});
