// @vitest-environment node
/** Integration per-file timings remain optional CI evidence, including on suite failure. */
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

it('every integration part wires both reporters and an always-upload, per-group artifact matching unit timing policy', () => {
  const { jobs } = yaml.load(readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  const parts = jobs['integration-part'];
  const suite = parts.steps.find(step => step.name?.startsWith('Real-git integration suite'));
  const upload = parts.steps.find(step => step.name === 'Upload integration timings');
  const unitUpload = jobs['test-shard'].steps.find(step => step.name === 'Upload shard timings');
  expect(suite.run).toContain('npm run test:integration:vitest -- --reporter=default --reporter=json --outputFile.json=coverage/timing-integration-${{ matrix.group }}.json');
  expect(upload.if).toBe(unitUpload.if);
  expect(upload.if).toContain('always()');
  expect(upload.uses).toBe(unitUpload.uses);
  // upload-artifact@v4 refuses a duplicate name within one run, so each matrix leg names its own artifact.
  expect(upload.with).toEqual({ name: 'timing-integration-${{ matrix.group }}', path: 'web-everything/coverage/timing-integration-${{ matrix.group }}.json', 'if-no-files-found': 'ignore' });
  expect(parts.steps.indexOf(upload)).toBeGreaterThan(parts.steps.indexOf(suite));
  // The aggregator only gates; it runs no suite and uploads nothing.
  expect(jobs.integration.steps.some(step => step.uses || step.run?.includes('test:integration:vitest'))).toBe(false);
});
