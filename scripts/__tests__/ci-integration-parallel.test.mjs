import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const yml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.github', 'workflows', 'ci.yml'), 'utf8');
const job = (name) => {
  const m = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][\\w-]*:\\n|^# |$(?![\\s\\S]))`, 'm').exec(yml);
  if (!m) throw new Error(`no job ${name}`);
  return m[1];
};

describe('ci.yml: integration suite runs as its own parallel job', () => {
  it('integration needs only `changes`, so it starts beside the shards', () => {
    expect(job('integration')).toMatch(/^    needs: changes$/m);
    expect(job('integration')).toContain('npm run test:integration:vitest');
  });
  it('the integration job runs even on card-only PRs (never job-skipped) and fails closed', () => {
    const j = job('integration');
    expect(j).toMatch(/if: \$\{\{ !cancelled\(\) \}\}/);
    expect(j).toContain('needs.changes.result');
  });
  it('`test` no longer runs the suite itself but still goes red when integration is not success', () => {
    const t = job('test');
    expect(t).not.toContain('npm run test:integration:vitest');
    expect(t).toMatch(/needs: \[changes, test-shard, integration\]/);
    expect(t).toContain('needs.integration.result');
  });
});
