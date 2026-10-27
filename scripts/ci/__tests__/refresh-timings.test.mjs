// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { downloadReports, expectedUnitShards, foldReports, main, refreshFromDir } from '../refresh-timings.mjs';
import { REPO_ROOT, timingsFromReports } from '../shard-assign.mjs';

// Public contracts for Phase 2:
// foldReports(dir) -> parsed report array, recursively matching timing-unit-*.json only.
// refreshFromDir({ dir, timingsFile, repoRoot }) -> { ok: boolean, reason: string }.
// Refusals return ok:false with an operator-readable reason; the CLI maps them to exit 2.
let root, repoRoot, dir, timingsFile;
const original = `${JSON.stringify({ _doc: 'old timings', unit: { 'removed.test.mjs': 99 }, soak: { 'baseline.test.mjs': 12 } }, null, 1)}\n`;
const files = Array.from({ length: 10 }, (_, i) => `tests/file-${i}.test.mjs`);
function report(file, ms = 1234) {
  return { testResults: [{ name: join(repoRoot, file), startTime: 100, endTime: 100 + ms }] };
}
function writeReport(index, body) {
  const file = join(dir, `artifact-${index}`, 'nested', `timing-unit-${index}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(body));
  return file;
}
// Shard reports are numbered 1..count, matching the fixture ci.yml matrix.
function seed(count = 10, coverage = 10) {
  return Array.from({ length: count }, (_, i) => writeReport(i + 1, report(files[i % coverage], 1234 + i * 100)));
}
// Extra test results ride in an existing shard's report, never as a stray report file.
function withResults(file, ...extra) {
  return { testResults: [report(file).testResults[0], ...extra] };
}
function cli(args = [`--dir=${dir}`]) {
  // Copy the future implementation into a throwaway repo: CLI defaults must never write real timings.
  const scripts = join(repoRoot, 'scripts', 'ci');
  mkdirSync(scripts, { recursive: true });
  for (const name of ['refresh-timings.mjs', 'shard-assign.mjs']) {
    copyFileSync(new URL(`../${name}`, import.meta.url), join(scripts, name));
  }
  return spawnSync(process.execPath, [join(scripts, 'refresh-timings.mjs'), ...args], {
    cwd: repoRoot, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
  });
}
// The minimum report count is one per CI unit shard, read from the checkout's ci.yml.
function writeCi(shards) {
  const ci = join(repoRoot, '.github', 'workflows', 'ci.yml');
  mkdirSync(dirname(ci), { recursive: true });
  writeFileSync(ci, yaml.safeDump({ jobs: { 'test-shard': { strategy: { matrix: { shard: shards } } } } }));
}
const tenShards = Array.from({ length: 10 }, (_, i) => i + 1);
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'refresh-timings-'));
  repoRoot = join(root, 'repo');
  dir = join(root, 'reports');
  timingsFile = join(repoRoot, 'scripts', 'ci', 'test-timings.json');
  mkdirSync(dirname(timingsFile), { recursive: true });
  mkdirSync(dir);
  mkdirSync(join(repoRoot, 'tests'));
  for (const file of files) writeFileSync(join(repoRoot, file), '');
  writeFileSync(join(repoRoot, 'vitest.config.ts'), "export default { test: { include: ['tests/**/*.test.mjs'] } };\n");
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(repoRoot, 'node_modules'), 'dir');
  writeFileSync(timingsFile, original);
  writeCi(tenShards);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('refresh-timings recursive report fold', () => {
  it('finds nested unit reports, ignores soak and unrelated JSON, and uses the existing timing fold', async () => {
    const a = report(files[0], 1234);
    const b = report(files[0], 2501);
    const c = report(files[1], 500);
    writeReport(1, a); writeReport(2, b); writeReport(3, c);
    writeFileSync(join(dir, 'timing-soak-1.json'), 'invalid ignored JSON');
    writeFileSync(join(dir, 'unrelated.json'), '{}');
    const reports = await foldReports(dir);
    expect(reports).toHaveLength(3);
    expect(reports).toEqual(expect.arrayContaining([a, b, c]));
    expect(timingsFromReports(reports, repoRoot)).toEqual({ [files[0]]: 2.5, [files[1]]: 0.5 });
    expect(readFileSync(timingsFile, 'utf8')).toBe(original);
  });

  it('returns no reports for an empty directory', async () => {
    expect(await foldReports(dir)).toEqual([]);
  });
});

describe('refresh-timings safety rails', () => {
  it('refuses an outside-checkout report even with complete inventory coverage, preserving existing bytes', async () => {
    seed();
    writeReport(10, withResults(files[9], { name: join(root, 'outside.test.mjs'), startTime: 0, endTime: 1000 }));
    const result = await refreshFromDir({ dir, timingsFile, repoRoot });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/repository-relative/);
    expect(readFileSync(timingsFile, 'utf8')).toBe(original);
  });

  it('refuses fewer than ten reports despite complete file coverage and leaves bytes untouched', async () => {
    seed(9);
    writeReport(1, { testResults: files.map((file) => report(file).testResults[0]) });
    const result = await refreshFromDir({ dir, timingsFile, repoRoot });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/missing timing-unit-10\.json/);
    expect(readFileSync(timingsFile, 'utf8')).toBe(original);
  });

  it('refuses ten reports covering only 80% of current tests, without writing', async () => {
    seed(10, 8);
    // Obsolete entries cannot inflate the coverage numerator.
    writeReport(10, withResults(files[1], ...Array.from({ length: 30 }, (_, i) => report(`removed-${i}.test.mjs`).testResults[0])));
    const result = await refreshFromDir({ dir, timingsFile, repoRoot });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/coverage|90|stale/i);
    expect(readFileSync(timingsFile, 'utf8')).toBe(original);
  });

  it('fails closed on an unreadable report directory and preserves existing timings', async () => {
    const result = await refreshFromDir({ dir: join(root, 'missing'), timingsFile, repoRoot });
    expect(result.ok).toBe(false);
    expect(result.reason).toEqual(expect.any(String));
    expect(result.reason.length).toBeGreaterThan(0);
    expect(readFileSync(timingsFile, 'utf8')).toBe(original);
  });

  it('fails closed on malformed matching JSON rather than silently skipping it', async () => {
    seed();
    writeFileSync(join(dir, 'timing-unit-broken.json'), '{broken');
    const result = await refreshFromDir({ dir, timingsFile, repoRoot });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/report|json|parse|invalid/i);
    expect(readFileSync(timingsFile, 'utf8')).toBe(original);
  });

  it('accepts exactly ten reports and exactly 90% coverage', async () => {
    seed(10, 9);
    const result = await refreshFromDir({ dir, timingsFile, repoRoot });
    expect(result).toMatchObject({ ok: true, reason: expect.any(String) });
    expect(Object.keys(JSON.parse(readFileSync(timingsFile, 'utf8')).unit)).toHaveLength(9);
  });

  it.each(['too few reports', 'low coverage'])('CLI exits 2 for %s and preserves the file', (why) => {
    seed(why === 'too few reports' ? 9 : 10, why === 'low coverage' ? 8 : 10);
    const result = cli();
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toMatch(/report|coverage|90|10/i);
    expect(readFileSync(timingsFile, 'utf8')).toBe(original);
  }, 20_000);
});

describe('refresh-timings writer compatibility', () => {
  it('writes byte-identical sorted output to shard-assign --update and preserves soak timings', async () => {
    const paths = seed();
    const scripts = dirname(timingsFile);
    const assign = join(scripts, 'shard-assign.mjs');
    copyFileSync(new URL('../shard-assign.mjs', import.meta.url), assign);
    const update = spawnSync(process.execPath, [assign, '--suite=unit', `--update=${paths.join(',')}`], {
      cwd: repoRoot, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
    });
    expect(update.error).toBeUndefined();
    expect(update.status).toBe(0);
    const expected = readFileSync(timingsFile, 'utf8');
    writeFileSync(timingsFile, original);
    expect((await refreshFromDir({ dir, timingsFile, repoRoot })).ok).toBe(true);
    const actual = readFileSync(timingsFile, 'utf8');
    expect(actual).toBe(expected);
    expect(JSON.parse(actual).soak).toEqual({ 'baseline.test.mjs': 12 });
    const unit = JSON.parse(actual).unit;
    expect(Object.keys(unit)).toEqual([...Object.keys(unit)].sort());
    expect(unit).not.toHaveProperty('removed.test.mjs');
  });

  it('writes only currently discovered test files, dropping obsolete report entries', async () => {
    seed();
    // A CI run built before a test file was renamed or deleted still reports the old name.
    writeReport(10, withResults(files[9], report('tests/renamed-away.test.mjs').testResults[0]));
    const result = await refreshFromDir({ dir, timingsFile, repoRoot });
    expect(result.ok).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(timingsFile, 'utf8')).unit)).toEqual([...files].sort());
  });
});

describe('refresh-timings report threshold follows the CI unit shard matrix', () => {
  it('needs one report per ci.yml unit shard, not a fixed ten', async () => {
    writeCi([1, 2, 3, 4, 5]);
    expect(expectedUnitShards(repoRoot)).toEqual([1, 2, 3, 4, 5]);
    seed(4);
    writeReport(1, { testResults: files.map((file) => report(file).testResults[0]) });
    expect((await refreshFromDir({ dir, timingsFile, repoRoot })).reason).toMatch(/Found 4 unit reports; need exactly one per CI unit shard \(5\): missing timing-unit-5\.json/);
    expect(readFileSync(timingsFile, 'utf8')).toBe(original);
    seed(5);
    writeReport(1, { testResults: files.map((file) => report(file).testResults[0]) });
    expect((await refreshFromDir({ dir, timingsFile, repoRoot })).ok).toBe(true);
  });

  it('a duplicate shard report cannot pad the count to stand in for a missing shard', async () => {
    seed(9);
    writeReport(1, { testResults: files.map((file) => report(file).testResults[0]) });
    const copy = join(dir, 'second-download', 'timing-unit-1.json');
    mkdirSync(dirname(copy), { recursive: true });
    copyFileSync(join(dir, 'artifact-1', 'nested', 'timing-unit-1.json'), copy);
    const result = await refreshFromDir({ dir, timingsFile, repoRoot });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Found 10 unit reports.*missing timing-unit-10\.json; duplicate timing-unit-1\.json/);
    expect(readFileSync(timingsFile, 'utf8')).toBe(original);
  });

  it('refuses a report from a shard the matrix does not have, even with every shard present', async () => {
    seed();
    writeReport(11, report(files[0]));
    const result = await refreshFromDir({ dir, timingsFile, repoRoot });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unexpected timing-unit-11\.json/);
    expect(readFileSync(timingsFile, 'utf8')).toBe(original);
  });

  it('matches the real ci.yml unit shards', () => {
    const ci = yaml.safeLoad(readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'));
    expect(expectedUnitShards()).toEqual(ci.jobs['test-shard'].strategy.matrix.shard);
  });

  it.each([
    ['a missing ci.yml', () => rmSync(join(repoRoot, '.github'), { recursive: true })],
    ['an empty shard matrix', () => writeCi([])],
    ['a non-list shard matrix', () => writeCi('${{ fromJSON(vars.SHARDS) }}')],
    ['duplicate shard ids', () => writeCi([1, 1, 2])],
  ])('refuses on %s and preserves the file', async (_, mutate) => {
    seed();
    mutate();
    expect(() => expectedUnitShards(repoRoot)).toThrow(/shard/i);
    const result = await refreshFromDir({ dir, timingsFile, repoRoot });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/shard/i);
    expect(readFileSync(timingsFile, 'utf8')).toBe(original);
  });
});

describe('refresh-timings atomic replacement', () => {
  const leftovers = () => readdirSync(dirname(timingsFile)).filter(name => name.endsWith('.pending'));

  it('a staged write that fails part-way leaves the destination bytes intact and no staging file', async () => {
    seed();
    const io = {
      writeFile: async (path, data, options) => { await writeFile(path, data.slice(0, 10), options); throw new Error('disk full'); },
    };
    const result = await refreshFromDir({ dir, timingsFile, repoRoot, io });
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/disk full/) });
    expect(readFileSync(timingsFile, 'utf8')).toBe(original);
    expect(leftovers()).toEqual([]);
  });

  it('a failed rename leaves the destination bytes intact and no staging file', async () => {
    seed();
    const io = { rename: async () => { throw new Error('rename refused'); } };
    const result = await refreshFromDir({ dir, timingsFile, repoRoot, io });
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/rename refused/) });
    expect(readFileSync(timingsFile, 'utf8')).toBe(original);
    expect(leftovers()).toEqual([]);
  });
});

describe('refresh-timings CI artifact download trust boundary', () => {
  const recorder = (runList = '[{"databaseId":4242}]') => {
    const calls = [];
    const exec = (cmd, args, options) => { calls.push({ cmd, args, options }); return args[1] === 'list' ? runList : ''; };
    return { calls, exec };
  };

  it('latest selects only the newest successful ci.yml push on main, then downloads unit artifacts by argv', async () => {
    const { calls, exec } = recorder();
    await downloadReports('latest', '/scratch/reports', { exec });
    expect(calls.map(({ cmd, args }) => [cmd, args])).toEqual([
      ['gh', ['run', 'list', '--workflow=ci.yml', '--branch=main', '--status=success', '--event=push', '--limit=1', '--json=databaseId']],
      ['gh', ['run', 'download', '4242', '--pattern=timing-unit-*', '--dir', '/scratch/reports']],
    ]);
    for (const { options } of calls) expect(options).toMatchObject({ cwd: REPO_ROOT, timeout: 120_000, maxBuffer: 1024 * 1024 });
  });

  it('an explicit numeric run downloads without a run lookup', async () => {
    const { calls, exec } = recorder();
    await downloadReports('77', '/scratch/reports', { exec });
    expect(calls.map(({ args }) => args)).toEqual([['run', 'download', '77', '--pattern=timing-unit-*', '--dir', '/scratch/reports']]);
  });

  it.each([
    ['no successful run', '[]'],
    ['a non-numeric run id', '[{"databaseId":"1;touch x"}]'],
    ['a missing run id', '[{}]'],
    ['a run id with a trailing newline', '[{"databaseId":"4242\\n"}]'],
  ])('refuses before any download when latest finds %s', async (_, runList) => {
    const { calls, exec } = recorder(runList);
    await expect(downloadReports('latest', '/scratch/reports', { exec })).rejects.toThrow(/No valid CI run ID/);
    expect(calls.map(({ args }) => args[1])).toEqual(['list']);
  });

  it.each(['1;x', '$(id)', '1 2', '-1', '', '77\n', '77\r', '77\u2028', '77\u2029'])('refuses explicit run id %j before any gh call', async (run) => {
    const { calls, exec } = recorder();
    await expect(downloadReports(run, '/scratch/reports', { exec })).rejects.toThrow(/No valid CI run ID/);
    expect(calls).toEqual([]);
  });

  it.each([
    [[]],
    [['--run=1;x']],
    [['--run=']],
    [['--run=12a']],
    [['--run=77\n']],
    [['--run=latest\r']],
    [['--run=77\u2028']],
    [['--run=77\u2029']],
    [['--dir=reports\n']],
    [['--dir=']],
    [['--run=latest', '--dir=x']],
    [['--update=x']],
  ])('main rejects argv %j with usage', async (argv) => {
    await expect(main(argv)).rejects.toThrow(/^usage: refresh-timings\.mjs/);
  });

  it('strips terminal control characters from refusal messages written to workflow logs', () => {
    seed();
    writeFileSync(join(dir, 'timing-unit-\u001b]8;;evil\u0007.json'), '{}');
    const result = cli();
    expect(result.status).toBe(2);
    const line = result.stderr.split('\n').find(text => text.includes('Invalid unit report'));
    expect(line).toContain('evil');
    expect(line).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  }, 20_000);
});
