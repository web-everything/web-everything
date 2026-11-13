import { it, expect } from 'vitest';
import { splitGuardReport, parseGuardReport, withGuardReport, finalizeGuardReport, createGuardCollector, GUARD_REPORT_MAX_BYTES } from '../remote-exec.mjs';

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

it('every recursive executeRemote retry re-attaches the guard report destination', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const source = readFileSync(join(process.cwd(), 'scripts/readiness/remote-exec.mjs'), 'utf8');
  // The delta-to-full retry sites (transfer failure and protected delta rejection) are the recursive calls with disableDelta:true.
  const inner = source.split('\n').filter(line => /disableDelta:true/.test(line) && /executeRemote\(\{argv/.test(line));
  expect(inner).toHaveLength(2);
  for (const line of inner) expect(line).toContain('argv:withGuardReport(argv,guardOutputFile)');
});

// The post-run guard block of executeRemote, extracted so its guarantees are testable with a fake fs.
const goodReport = Buffer.from(JSON.stringify({ numTotalTestSuites: 1, testResults: [{ name: '/work/r-1/scripts/a.test.mjs', assertionResults: [{ status: 'passed' }] }] }));
const fakeFs = (existing = null, failWrite = false) => {
  const writes = [];
  return { writes,
    lstat: async () => { if (!existing) throw new Error('ENOENT'); return existing; },
    writeFile: async (path, text, options) => { if (failWrite) throw new Error('EACCES'); writes.push({ path, text, options }); } };
};
const finalize = (over = {}) => finalizeGuardReport({ outputFile: '/tmp/we/report.json', chunks: [goodReport], bytes: goodReport.length, code: 0,
  files: ['scripts/a.test.mjs'], cwd: '/lane', remoteRoot: '/work/r-1', fs: fakeFs(), ...over });

it('collectGuard keeps only stdout chunks and stops collecting past the 16MB cap', async () => {
  const collector = createGuardCollector();
  collector.collect(Buffer.from('err'), 'stderr');
  collector.collect(Buffer.from('out'), 'stdout');
  expect(Buffer.concat(collector.chunks).toString()).toBe('out');
  collector.collect(Buffer.alloc(GUARD_REPORT_MAX_BYTES), 'stdout');
  expect(collector.bytes).toBeGreaterThan(GUARD_REPORT_MAX_BYTES);
  expect(collector.chunks).toHaveLength(1);
});

it('executeRemote wires the collector into the run exec only when a guard report destination exists', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const source = readFileSync(join(process.cwd(), 'scripts/readiness/remote-exec.mjs'), 'utf8');
  expect(source).toContain("command === 'run' && guardOutputFile ? {onOutput:collectGuard} : {}");
  expect(source).toContain('const {collect:collectGuard');
  expect(source).toMatch(/await finalizeGuardReport\(\{outputFile:guardOutputFile/);
});

it('a green run with a usable report writes it remapped to the lane, mode 0600, and keeps the verdict', async () => {
  const fs = fakeFs();
  expect(await finalize({ fs })).toBeNull();
  expect(fs.writes).toHaveLength(1);
  expect(fs.writes[0]).toMatchObject({ path: '/tmp/we/report.json', options: { mode: 0o600 } });
  expect(JSON.parse(fs.writes[0].text).testResults[0].name).toBe('/lane/scripts/a.test.mjs');
});

it('a green run without a usable report returns guard-report-unavailable so the caller reruns locally', async () => {
  const unavailable = { mode: 'cancelled', terminated: true, code: 1, reason: 'guard-report-unavailable' };
  const fs = fakeFs();
  expect(await finalize({ fs, chunks: [Buffer.from('no report')], bytes: 9 })).toEqual(unavailable);
  expect(await finalize({ fs, bytes: GUARD_REPORT_MAX_BYTES + 1 })).toEqual(unavailable);
  expect(await finalize({ fs, fs: fakeFs(null, true) })).toEqual(unavailable);
  expect(await finalize({ fs: fakeFs({ isSymbolicLink: () => true }) })).toEqual(unavailable);
  expect(fs.writes).toHaveLength(0);
});

it('a symlink at the destination is never written through, even for a usable report', async () => {
  const fs = fakeFs({ isSymbolicLink: () => true });
  await finalize({ fs });
  expect(fs.writes).toHaveLength(0);
});

it('a red run keeps its verdict without a usable report and never writes one', async () => {
  const fs = fakeFs();
  expect(await finalize({ fs, code: 1, chunks: [Buffer.from('no report')], bytes: 9 })).toBeNull();
  expect(await finalize({ fs, code: 1, bytes: GUARD_REPORT_MAX_BYTES + 1 })).toBeNull();
  expect(await finalize({ fs: fakeFs(null, true), code: 1 })).toBeNull();
  expect(fs.writes).toHaveLength(0);
});

it('a run with no guard report destination is untouched', async () => {
  const fs = fakeFs();
  expect(await finalize({ fs, outputFile: undefined })).toBeNull();
  expect(fs.writes).toHaveLength(0);
});
