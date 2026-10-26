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
import { realpathSync } from 'node:fs';
import { REPO_ROOT, TIMINGS_FILE, listUnitTestFiles, timingsFromReports, loadTimings, formatUpdatedTimings } from './shard-assign.mjs';

/** Recursively parse unit reports only; malformed or unreadable evidence throws. */
export async function foldReports(dir) {
  const reports = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) reports.push(...await foldReports(path));
    else if (/^timing-unit-.*\.json$/.test(entry.name)) {
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

/** Validate all evidence before atomically replacing the unit map, preserving soak timings. */
export async function refreshFromDir({ dir, timingsFile = TIMINGS_FILE, repoRoot = REPO_ROOT }) {
  let pending;
  try {
    const reports = await foldReports(dir);
    if (reports.length < 10) return { ok: false, reason: `Found ${reports.length} unit reports; need at least 10. Download all timing-unit-* artifacts from a successful full CI run.` };
    const timings = timingsFromReports(reports, repoRoot);
    const files = await listUnitTestFiles(repoRoot);
    const covered = files.filter(file => Object.hasOwn(timings, file)).length;
    if (!files.length || covered / files.length < 0.9) {
      return { ok: false, reason: `Unit timing coverage ${covered}/${files.length} is below 90%. Use a current successful full CI run or rerun CI on main.` };
    }
    const output = formatUpdatedTimings(loadTimings(timingsFile), 'unit', timings);
    pending = `${timingsFile}.${randomUUID()}.pending`;
    await writeFile(pending, output, { flag: 'wx' });
    await rename(pending, timingsFile);
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
