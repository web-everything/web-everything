import { it, expect } from 'vitest';
import { splitGuardReport, parseGuardReport, withGuardReport } from '../remote-exec.mjs';

const argv = ['npx', 'vitest', 'run', 'scripts/a.test.mjs', '--reporter=default', '--reporter=json', '--outputFile.json=/tmp/we/report.json'];

it('splits an absolute json report path from the remote argv', () => {
  const split = splitGuardReport(argv);
  expect(split.outputFile).toBe('/tmp/we/report.json');
  expect(split.argv).toEqual(argv.slice(0, -1));
});

it('leaves other commands, relative paths and traversal untouched', () => {
  expect(splitGuardReport(['npx', 'vitest', 'run', 'a', '--outputFile.json=rel.json', '--reporter=json']).outputFile).toBeUndefined();
  expect(splitGuardReport([...argv.slice(0, -1), '--outputFile.json=/tmp/../etc/x.json']).outputFile).toBeUndefined();
  expect(splitGuardReport(['npm', 'run', 'test:unit', '--', '--outputFile.json=/tmp/x.json']).outputFile).toBeUndefined();
});

it('remaps Forge paths in the stdout report to the lane root', () => {
  const report = { numTotalTestSuites: 1, testResults: [{ name: '/work/run1/scripts/a.test.mjs', assertionResults: [{ status: 'passed' }] }] };
  const stdout = Buffer.from(`✓ scripts/a.test.mjs (1 test)\n${JSON.stringify(report, null, 2)}\n`);
  const parsed = JSON.parse(parseGuardReport(stdout, ['scripts/a.test.mjs'], '/lane', '/work/run1'));
  expect(parsed.testResults[0].name).toBe('/lane/scripts/a.test.mjs');
});

it('never credits a nested or suffix-matching test as the guard file', () => {
  const report = { numTotalTestSuites: 2, testResults: [
    { name: '/work/r-123/fixtures/scripts/a.test.mjs', assertionResults: [{ status: 'failed' }] },
    { name: '/elsewhere/work/r-123/scripts/a.test.mjs', assertionResults: [{ status: 'failed' }] },
  ] };
  const parsed = JSON.parse(parseGuardReport(Buffer.from(JSON.stringify(report)), ['scripts/a.test.mjs'], '/lane', '/work/r-123'));
  expect(parsed.testResults.map(t => t.name)).toEqual([
    '/work/r-123/fixtures/scripts/a.test.mjs', '/elsewhere/work/r-123/scripts/a.test.mjs']);
});

it('fails closed on remapping when no Forge run root is known', () => {
  const report = { numTotalTestSuites: 1, testResults: [{ name: '/work/r-123/scripts/a.test.mjs', assertionResults: [] }] };
  const parsed = JSON.parse(parseGuardReport(Buffer.from(JSON.stringify(report)), ['scripts/a.test.mjs'], '/lane'));
  expect(parsed.testResults[0].name).toBe('/work/r-123/scripts/a.test.mjs');
});

it('returns null for a missing or unparseable report (fail closed)', () => {
  expect(parseGuardReport(Buffer.from('no report here'), ['a'], '/lane')).toBeNull();
  expect(parseGuardReport(Buffer.from('{"numTotalTestSuites": 1, "testResults": '), ['a'], '/lane')).toBeNull();
  expect(parseGuardReport(Buffer.from('{"numTotalTestSuites": 1}'), ['a'], '/lane')).toBeNull();
});

it('re-attaches the guard report destination for a delta-to-full retry', () => {
  const split = splitGuardReport(argv);
  const retryArgv = withGuardReport(split.argv, split.outputFile);
  expect(retryArgv).toEqual(argv);
  expect(splitGuardReport(retryArgv).outputFile).toBe('/tmp/we/report.json');
  expect(withGuardReport(split.argv, undefined)).toEqual(split.argv);
});
