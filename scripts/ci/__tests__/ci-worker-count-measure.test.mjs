import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

const { jobs } = yaml.load(readFileSync(resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8'));

describe('CI worker count and shard measurements', () => {
  it('sets the test-shard worker override with an operator rollback', () => {
    expect(jobs['test-shard'].env.WE_VITEST_MAX_WORKERS).toBe("${{ vars.WE_VITEST_MAX_WORKERS || '2' }}");
  });

  describe.each(['test-shard', 'soak-shard'])('%s', (name) => {
    const job = jobs[name];

    it('always measures resources without failing the shard', () => {
      const measure = job.steps.find((step) => step.name === 'Measure shard resources');
      expect(measure).toBeDefined();
      expect(measure.if).toContain('always()');
      expect(measure['continue-on-error']).toBe(true);
      expect(measure.run).toContain('nproc');
      expect(measure.run).toContain('/sys/fs/cgroup/memory.peak');
      expect(measure.run).toContain('unavailable');
      expect(measure.run).toContain('GITHUB_STEP_SUMMARY');
      expect(measure.run).toContain('/proc/uptime');
      const upload = job.steps.at(-1);
      expect(job.steps.at(-2)).toBe(measure);
      expect(upload.uses).toBe('actions/upload-artifact@v4');
      expect(upload.if).toContain('always()');
      expect(upload['continue-on-error']).toBe(true);
      expect(upload.with.name).toBe(`shard-resources-${name.replace('-shard', '')}-` + '${{ matrix.shard }}');
      expect(upload.with.path).toBe(name === 'test-shard' ? 'web-everything/shard-resources.json' : 'shard-resources.json');
      expect(upload.with['if-no-files-found']).toBe('ignore');
    });

    it('keeps test, unit and soak run steps blocking', () => {
      expect(job['continue-on-error']).toBeUndefined();
      const runs = job.steps.filter((step) => /npm run test:/.test(step.run ?? ''));
      expect(runs.length).toBeGreaterThan(0);
      for (const step of runs) expect(step['continue-on-error']).toBeUndefined();
    });
  });
});
