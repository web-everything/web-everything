import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { MQ_FREEZE_SUMMARY_NEEDS } from '../drain-queue-safety.mjs';

const workflow = yaml.load(readFileSync('.github/workflows/ci.yml', 'utf8'));
describe('P freeze summary workflow contract', () => {
  it('each P summary’s step name exists in its ci.yml job', () => {
    expect(Object.keys(MQ_FREEZE_SUMMARY_NEEDS).sort()).toEqual(['coverage-merge', 'integration', 'test']);
    for (const [name, proof] of Object.entries(MQ_FREEZE_SUMMARY_NEEDS))
      expect(workflow.jobs[name].steps.map(s => s.name)).toContain(proof.step);
  });
  it('each P needs list equals the ci.yml needs', () => {
    for (const [name, proof] of Object.entries(MQ_FREEZE_SUMMARY_NEEDS))
      expect(Object.keys(proof.needs).sort()).toEqual([...workflow.jobs[name].needs].sort());
  });
  it('each P matrix member list equals the ci.yml matrix', () => {
    for (const proof of Object.values(MQ_FREEZE_SUMMARY_NEEDS)) {
      for (const [name, need] of Object.entries(proof.needs)) {
        const matrix = workflow.jobs[name].strategy?.matrix;
        const axes = matrix && Object.entries(matrix).filter(([key]) => !['include', 'exclude'].includes(key));
        // A single plain axis, with no include/exclude rewriting the expanded member set.
        if (matrix) { expect(axes).toHaveLength(1); expect(matrix.exclude).toBeUndefined();
          // An include may only annotate existing members (e.g. a timeout), never add or rename one.
          for (const item of matrix.include ?? []) expect(axes[0][1].map(String)).toContain(String(item[axes[0][0]])); }
        expect(need.members).toEqual(axes ? axes[0][1].map(String) : undefined);
      }
    }
  });
});
