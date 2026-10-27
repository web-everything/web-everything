#!/usr/bin/env node
/** Refresh unit timings from CI evidence. Refusals exit 2 without replacing existing timings.
 * CLI: --dir=<downloaded-reports> | --run=<id|latest>
 * Soak is left unchanged: run-shard.mjs currently supplies no JSON reporter/output option.
 */
import { readdir, readFile, writeFile, rename, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import yaml from 'js-yaml';
import { REPO_ROOT, TIMINGS_FILE, listUnitTestFiles, timingsFromReports, loadTimings, formatUpdatedTimings } from './shard-assign.mjs';

/** Recursively parse unit reports only; malformed or unreadable evidence throws. Report filenames are appended to `names`. */
export async function foldReports(dir, names = []) {
  const reports = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) reports.push(...await foldReports(path, names));
    else if (/^timing-unit-.*\.json$/.test(entry.name)) {
      names.push(entry.name);
      if (!entry.isFile()) throw new Error(`Invalid report file: ${entry.name}`);
      const report = JSON.parse(await readFile(path, 'utf8'));
      if (!report || !Array.isArray(report.testResults) || report.testResults.some(r =>
        !r || typeof r.name !== 'string' || !Number.isFinite(r.startTime) ||
        !Number.isFinite(r.endTime) || r.endTime < r.startTime)) {
        throw new Error(`Invalid unit report: ${entry.name}`);
      }
      reports.push(report);
    }
  }
  return reports;
}

/** The CI unit shard ids from ci.yml's test-shard matrix; each uploads one timing-unit-<id> report. Unreadable or unexpected shapes throw. */
export function expectedUnitShards(repoRoot = REPO_ROOT) {
  let shards;
  try {
    shards = yaml.safeLoad(readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8'))?.jobs?.['test-shard']?.strategy?.matrix?.shard;
  } catch (error) {
    throw new Error(`Cannot read the CI unit shard matrix (${error.message})`);
  }
  if (!Array.isArray(shards) || !shards.length || !shards.every(Number.isInteger) || new Set(shards).size !== shards.length) {
    throw new Error('ci.yml test-shard matrix is not a non-empty list of distinct shard numbers');
  }
  return shards;
}

/** Exactly one report per shard: a duplicate or stray file must not stand in for a missing shard. */
function shardReportProblem(names, shards) {
  const expected = shards.map(shard => `timing-unit-${shard}.json`);
  const missing = expected.filter(name => !names.includes(name));
  const duplicate = [...new Set(names.filter((name, i) => names.indexOf(name) !== i))];
  const unexpected = names.filter(name => !expected.includes(name));
  const problems = [['missing', missing], ['duplicate', duplicate], ['unexpected', unexpected]]
    .filter(([, list]) => list.length).map(([kind, list]) => `${kind} ${list.join(', ')}`);
  return problems.length ? `Found ${names.length} unit reports; need exactly one per CI unit shard (${shards.length}): ${problems.join('; ')}` : null;
}

/** Validate all evidence before atomically replacing the unit map, preserving soak timings. */
export async function refreshFromDir({ dir, timingsFile = TIMINGS_FILE, repoRoot = REPO_ROOT, io = {} }) {
  const { writeFile: write = writeFile, rename: move = rename } = io;
  let pending;
  try {
    const names = [];
    const reports = await foldReports(dir, names);
    const problem = shardReportProblem(names, expectedUnitShards(repoRoot));
    if (problem) return { ok: false, reason: `${problem}. Download all timing-unit-* artifacts from one successful full CI run.` };
    const measured = timingsFromReports(reports, repoRoot);
    const files = await listUnitTestFiles(repoRoot);
    // Keep current files only: a run built before a rename/delete still reports the old name.
    const timings = Object.fromEntries(files.filter(file => Object.hasOwn(measured, file)).map(file => [file, measured[file]]));
    const covered = Object.keys(timings).length;
    if (!files.length || covered / files.length < 0.9) {
      return { ok: false, reason: `Unit timing coverage ${covered}/${files.length} is below 90%. Use a current successful full CI run or rerun CI on main.` };
    }
    const output = formatUpdatedTimings(loadTimings(timingsFile), 'unit', timings);
    pending = `${timingsFile}.${randomUUID()}.pending`;
    await write(pending, output, { flag: 'wx' });
    await move(pending, timingsFile);
    return { ok: true, reason: `Updated unit timings from ${reports.length} reports: ${covered}/${files.length} current files covered.` };
  } catch (error) {
    return { ok: false, reason: `Timing refresh refused: ${error.message}. Check the downloaded reports and retry with complete CI evidence.` };
  } finally {
    if (pending) await rm(pending, { force: true });
  }
}

/** Download with bounded argv-based GitHub calls; no shell interpolation of run IDs. */
export async function downloadReports(run, dir, { exec } = {}) {
  exec ??= (await import('../lib/gh-throttle.mjs')).execFileSyncThrottled;
  const options = { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 };
  let id = run;
  if (run === 'latest') {
    const runs = JSON.parse(exec('gh', ['run', 'list', '--workflow=ci.yml', '--branch=main', '--status=success', '--event=push', '--limit=1', '--json=databaseId'], options));
    id = String(runs[0]?.databaseId ?? '');
  }
  if (!/^\d+$/.test(id)) throw new Error('No valid CI run ID; supply --run=<id> or wait for a successful ci.yml push on main.');
  exec('gh', ['run', 'download', id, '--pattern=timing-unit-*', '--dir', dir], options);
}

export async function main(argv) {
  if (argv.length !== 1 || !/^--(?:dir=.+|run=(?:latest|\d+))$/.test(argv[0])) {
    throw new Error('usage: refresh-timings.mjs --dir=<reports> | --run=<id|latest>');
  }
  let scratch;
  try {
    const dir = argv[0].startsWith('--dir=') ? resolve(argv[0].slice(6))
      : (scratch = await mkdtemp(join(tmpdir(), 'ci-timings-')));
    if (scratch) await downloadReports(argv[0].slice(6), dir);
    const result = await refreshFromDir({ dir });
    process[result.ok ? 'stdout' : 'stderr'].write(`${result.reason.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')}\n`);
    return result.ok ? 0 : 2;
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    process.stderr.write(`${error.message.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')}\n`);
    process.exitCode = 2;
  });
}
