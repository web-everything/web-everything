// @vitest-environment node
/** Integration per-file timings remain optional CI evidence, including on suite failure. */
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

it('every integration matrix part wires both reporters and an always-upload artifact matching unit timing policy', () => {
  const { jobs } = yaml.load(readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  const part = jobs['integration-part'];
  expect(part.strategy.matrix.group.length).toBeGreaterThan(0);
  const suite = part.steps.find(step => step.name?.startsWith('Real-git integration suite'));
  const upload = part.steps.find(step => step.name === 'Upload integration timings');
  const unitUpload = jobs['test-shard'].steps.find(step => step.name === 'Upload shard timings');
  expect(suite.env).toEqual({ WE_INTEGRATION_GROUP: '${{ matrix.group }}' });
  expect(suite.run).toContain('npm run test:integration:vitest -- --reporter=default --reporter=json --outputFile.json=coverage/timing-integration-${{ matrix.group }}.json');
  expect(upload.if).toBe(unitUpload.if);
  expect(upload.if).toContain('always()');
  expect(upload.uses).toBe(unitUpload.uses);
  // Per-group name: upload-artifact@v4 fails a matrix leg whose artifact name another leg already used.
  expect(upload.with).toEqual({
    name: 'timing-integration-${{ matrix.group }}',
    path: 'web-everything/coverage/timing-integration-${{ matrix.group }}.json',
    'if-no-files-found': 'ignore',
  });
  expect(part.steps.indexOf(upload)).toBeGreaterThan(part.steps.indexOf(suite));
});
