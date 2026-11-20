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
  it('integration-part needs only `changes`, so the parts start beside the shards', () => {
    expect(job('integration-part')).toMatch(/^    needs: changes$/m);
    expect(job('integration-part')).toContain('npm run test:integration:vitest');
  });
  it('the integration parts run even on card-only PRs (never job-skipped) and the aggregate fails closed', () => {
    expect(job('integration-part')).toMatch(/if: \$\{\{ !cancelled\(\) \}\}/);
    const j = job('integration');
    expect(j).toMatch(/needs: \[changes, integration-part\]/);
    expect(j).toMatch(/if: \$\{\{ always\(\) \}\}/);
    expect(j).toContain('needs.changes.result');
    expect(j).toContain('needs.integration-part.result');
  });
  it('`test` no longer runs the suite itself but still goes red when integration is not success', () => {
    const t = job('test');
    expect(t).not.toContain('npm run test:integration:vitest');
    expect(yaml.load(yml).jobs.test.needs).toEqual(expect.arrayContaining(['changes', 'test-shard', 'integration', 'standards', 'coverage-merge', 'host-paths']));
    expect(t).toContain('needs.integration.result');
  });
});
