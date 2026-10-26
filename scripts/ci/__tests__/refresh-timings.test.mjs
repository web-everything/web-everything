// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { foldReports, refreshFromDir } from '../refresh-timings.mjs';
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
function seed(count = 10, coverage = 10) {
  return Array.from({ length: count }, (_, i) => writeReport(i, report(files[i % coverage], 1234 + i * 100)));
}
function cli() {
  // Copy the future implementation into a throwaway repo: CLI defaults must never write real timings.
  const scripts = join(repoRoot, 'scripts', 'ci');
  mkdirSync(scripts, { recursive: true });
  for (const name of ['refresh-timings.mjs', 'shard-assign.mjs']) {
    copyFileSync(new URL(`../${name}`, import.meta.url), join(scripts, name));
  }
  return spawnSync(process.execPath, [join(scripts, 'refresh-timings.mjs'), `--dir=${dir}`], {
    cwd: repoRoot, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
  });
}
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
    writeReport(20, { testResults: [{ name: join(root, 'outside.test.mjs'), startTime: 0, endTime: 1000 }] });
    const result = await refreshFromDir({ dir, timingsFile, repoRoot });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/repository-relative/);
    expect(readFileSync(timingsFile, 'utf8')).toBe(original);
  });

  it('refuses fewer than ten reports despite complete file coverage and leaves bytes untouched', async () => {
    seed(9);
    writeReport(0, { testResults: files.map((file) => report(file).testResults[0]) });
    const result = await refreshFromDir({ dir, timingsFile, repoRoot });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/report|10|ten/i);
    expect(readFileSync(timingsFile, 'utf8')).toBe(original);
  });

  it('refuses ten reports covering only 80% of current tests, without writing', async () => {
    seed(10, 8);
    // Obsolete entries cannot inflate the coverage numerator.
    writeReport(20, { testResults: Array.from({ length: 30 }, (_, i) => report(`removed-${i}.test.mjs`).testResults[0]) });
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
});
