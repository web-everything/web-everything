// @vitest-environment node
/** Integration per-file timings remain optional CI evidence, including on suite failure. */
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

it('integration wires both reporters and an always-upload artifact matching unit timing policy', () => {
  const { jobs } = yaml.load(readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  const suite = jobs.integration.steps.find(step => step.name?.startsWith('Real-git integration suite'));
  const upload = jobs.integration.steps.find(step => step.name === 'Upload integration timings');
  const unitUpload = jobs['test-shard'].steps.find(step => step.name === 'Upload shard timings');
  expect(suite.run).toContain('npm run test:integration:vitest -- --reporter=default --reporter=json --outputFile.json=coverage/timing-integration.json');
  expect(upload.if).toBe(unitUpload.if);
  expect(upload.if).toContain('always()');
  expect(upload.uses).toBe(unitUpload.uses);
  expect(upload.with).toEqual({ name: 'timing-integration', path: 'web-everything/coverage/timing-integration.json', 'if-no-files-found': 'ignore' });
  expect(jobs.integration.steps.indexOf(upload)).toBeGreaterThan(jobs.integration.steps.indexOf(suite));
});
