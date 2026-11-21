// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const dir = new URL('../../../.github/workflows/', import.meta.url);
const workflow = yaml.load(readFileSync(new URL('test-selection-measure.yml', dir), 'utf8'));
const job = workflow.jobs['test-selection-measure'];
const shadow = job.steps.find(s => s.name === 'Shadow full-suite run (json report)');

describe('test-selection measure produces data (advisory)', () => {
  it('gives the full shadow run at least 45 minutes (15 min timed out on all 15 real runs)', () => {
    expect(shadow).toBeDefined();
    expect(shadow['timeout-minutes']).toBeGreaterThanOrEqual(45);
  });

  it('keeps the job cap above the shadow step plus setup and the integration run', () => {
    expect(job['timeout-minutes']).toBeGreaterThan(shadow['timeout-minutes'] + 8);
  });

  it('stays advisory: continue-on-error on the job and the shadow steps', () => {
    expect(job['continue-on-error']).toBe(true);
    expect(shadow['continue-on-error']).toBe(true);
  });

  it('triggers only on push to main and manual dispatch (not every PR push)', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['push', 'workflow_dispatch']);
    expect(workflow.on.push.branches).toEqual(['main']);
  });

  it('measures from the selected base and uploads the covered merges', () => {
    const base = job.steps.find(s => s.id === 'base');
    const rec = job.steps.find(s => String(s.run ?? '').includes('test-selection.mjs --measure'));
    expect(base.run).toContain('node scripts/ci/measure-base.mjs measure-covered.txt');
    expect(base.run.trim().split('\n').map(line => line.trim())).toEqual([
      'set -eu',
      'base=$(node scripts/ci/measure-base.mjs measure-covered.txt)',
      'test -n "$base"',
      'echo "base=$base" >> "$GITHUB_OUTPUT"',
    ]);
    expect(base.env.GH_TOKEN).toBe('${{ github.token }}');
    expect(job.steps.indexOf(base)).toBeLessThan(job.steps.indexOf(rec));
    expect(rec.run).toContain('--base=${{ steps.base.outputs.base }}');
    expect(workflow.permissions.actions).toBe('read');
    expect(workflow.concurrency['cancel-in-progress']).toBe("${{ github.ref != 'refs/heads/main' }}");
    const artifact = job.steps.find(s => s.with?.name === 'false-green-signal');
    expect(artifact.with.path).toBe('web-everything/false-green-log.json');
    const covered = job.steps.find(s => s.with?.name === 'measure-covered');
    expect(covered.with.path).toBe('web-everything/measure-covered.txt');
    expect(covered.if).toBe('always()');
  });

  it('is still gated on the repo variable (or manual dispatch)', () => {
    expect(String(job.if)).toContain("vars.WE_MEASURE_TEST_SELECTION == '1'");
  });

  it('is never needed by another job in any workflow', () => {
    for (const f of readdirSync(dir).filter(n => /\.ya?ml$/.test(n))) {
      const wf = yaml.load(readFileSync(new URL(f, dir), 'utf8'));
      for (const [name, j] of Object.entries(wf.jobs ?? {})) {
        if (f === 'test-selection-measure.yml') continue;
        expect([j.needs ?? []].flat(), `${f}:${name}`).not.toContain('test-selection-measure');
      }
    }
  });
});
