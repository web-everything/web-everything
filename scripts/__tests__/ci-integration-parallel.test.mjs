import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';

const yml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.github', 'workflows', 'ci.yml'), 'utf8');
const job = (name) => {
  const m = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][\\w-]*:\\n|^# |$(?![\\s\\S]))`, 'm').exec(yml);
  if (!m) throw new Error(`no job ${name}`);
  return m[1];
};

describe('ci.yml: integration suite runs as its own parallel job', () => {
  it.each(['ci.yml', 'hetzner-jobs.yml'])('%s integration executes test:integration:vitest', (workflow) => {
    const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.github', 'workflows', workflow), 'utf8');
    const integration = yaml.load(text).jobs.integration;
    const suiteSteps = integration.steps.filter((step) => step.run?.trim() === 'npm run test:integration:vitest');
    expect(suiteSteps).toHaveLength(1);
    expect(suiteSteps[0]['working-directory']).toBe('web-everything');
    expect(suiteSteps[0].if).toBe(workflow === 'ci.yml' ? "${{ steps.gate.outputs.run == 'true' }}" : undefined);
  });

  it('integration needs only `changes`, so it starts beside the shards', () => {
    expect(job('integration')).toMatch(/^    needs: changes$/m);
    expect(job('integration')).toContain('npm run test:integration:vitest');
  });
  it('the integration job runs even on card-only PRs (within its hosted event path) and fails closed', () => {
    const j = job('integration');
    expect(yaml.load(yml).jobs.integration.if).toBe("${{ !cancelled() && (github.event_name == 'pull_request' || github.event_name == 'workflow_dispatch') }}");
    expect(j).toContain('needs.changes.result');
  });
  it('`test` no longer runs the suite itself but still goes red when integration is not success', () => {
    const t = job('test');
    expect(t).not.toContain('npm run test:integration:vitest');
    expect(yaml.load(yml).jobs.test.needs).toEqual(expect.arrayContaining(['changes', 'test-shard', 'integration', 'standards', 'coverage-merge', 'host-paths']));
    expect(t).toContain('needs.integration.result');
  });
});
