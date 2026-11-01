// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const raw = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const { jobs } = yaml.load(raw);

// 2026-11-01: `ubuntu-latest` moved to Ubuntu 26.04; Playwright 1.58.1 refuses `playwright install --with-deps`
// there ("does not support chromium on ubuntu26.04-x64"), turning main's `smoke` job red. Any job that runs
// `playwright install --with-deps` must sit on an explicitly pinned runner image Playwright supports.
describe('ci.yml jobs that run `playwright install --with-deps`', () => {
  const withDeps = Object.entries(jobs).filter(([, job]) =>
    (job.steps ?? []).some((s) => /playwright install\b.*--with-deps/.test(s.run ?? '')));

  it('exist (smoke)', () => {
    expect(withDeps.map(([name]) => name)).toContain('smoke');
  });

  it.each(withDeps.map(([name, job]) => [name, job['runs-on']]))('%s pins runs-on to ubuntu-24.04, not a floating -latest', (_name, runsOn) => {
    expect(runsOn).toBe('ubuntu-24.04');
  });
});
