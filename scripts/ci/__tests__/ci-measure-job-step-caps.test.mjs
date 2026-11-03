// @vitest-environment node
// Main went red at 1b2aa007d with NO code cause: the report-only `test-selection-measure` job (continue-on-error, gates
// nothing) ran its two shadow vitest runs back to back, exceeded its 30-minute JOB cap, and GitHub marked the whole CI run
// `cancelled` — which the red-main detector reads as red. A job-level timeout cancels the run even under
// `continue-on-error`; a STEP-level timeout only fails that step (which `|| true`/continue-on-error absorbs). So every
// long shadow step must carry its own cap, and the caps must sum to less than the job cap.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const { jobs } = yaml.load(readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'));
const job = jobs['test-selection-measure'];
const steps = job.steps;
const byName = (n) => steps.find((s) => s.name === n);

describe('test-selection-measure never trips its job-level cap', () => {
  it('is still report-only (continue-on-error)', () => {
    expect(job['continue-on-error']).toBe(true);
  });

  const shadow = ['Shadow full-suite run (json report)', 'Shadow integration-suite run (json report)'];

  it.each(shadow)('%s has its own step timeout-minutes', (name) => {
    const s = byName(name);
    expect(s, `step ${name} missing`).toBeDefined();
    expect(typeof s['timeout-minutes']).toBe('number');
  });

  it('the summed step caps (plus ~10 min of setup) fit under the job cap', () => {
    const stepCaps = steps.reduce((sum, s) => sum + (s['timeout-minutes'] ?? 0), 0);
    expect(stepCaps + 10).toBeLessThanOrEqual(job['timeout-minutes']);
  });
});
