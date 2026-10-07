#!/usr/bin/env node
/**
 * @file shard-assign.mjs — card 11 (perf sweep 2026-10-07): assign test files to CI shards by MEASURED time.
 *
 * Why: vitest's own `--shard=i/N` splits by file count/hash, blind to cost, so unit shard 3 ran 6.4-6.9 min against
 * 3.0-5.0 for the others and the soak shards ran 4.9-13.4 min. Here each file carries a measured duration
 * (`scripts/ci/test-timings.json`) and a greedy longest-processing-time-first pass hands the next-heaviest file to
 * the lightest shard, which keeps the shards within about one file's cost of each other.
 *
 * Every file still lands in exactly ONE shard (the guard below proves it), so which tests run is unchanged and the
 * merged coverage is unchanged — only WHERE they run moves.
 *
 * New files: a file with no stored timing gets the MEDIAN of the stored timings for its suite (most test files are
 * small, so the median is a fair guess), so a brand-new test lands in a shard automatically with no list to edit.
 * Refresh the stored timings from real CI data with `--update` (see below); a stale table only costs balance, never
 * correctness.
 *
 * CLI:
 *   node scripts/ci/shard-assign.mjs --suite=unit|soak --shard=<i>/<N>    one file per line, repo-relative
 *   node scripts/ci/shard-assign.mjs --suite=unit|soak --update=<vitest-json>[,<vitest-json>...]
 *                                    rewrite that suite's timings from vitest `--reporter=json` reports
 *                                    (the CI shards upload theirs as `timing-<suite>-<shard>` artifacts)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');
export const TIMINGS_FILE = join(HERE, 'test-timings.json');

export function loadTimings(file = TIMINGS_FILE) {
  if (!existsSync(file)) return { unit: {}, soak: {} };
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  return { unit: parsed.unit ?? {}, soak: parsed.soak ?? {} };
}

export function median(values) {
  if (!values.length) return 1;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Greedy longest-first assignment. `files` are repo-relative; `timings` maps file -> seconds (a missing file gets
 * the median of `timings`). Returns an array of `total` arrays (shard index 0-based), each sorted by name.
 * Deterministic: ties break by file name, then lowest shard index.
 */
export function assignByTime(files, timings, total) {
  if (!Number.isInteger(total) || total < 1) throw new Error(`shard-assign: total must be a positive integer, got "${total}"`);
  const fallback = median(Object.values(timings));
  const cost = (f) => (Number.isFinite(timings[f]) ? timings[f] : fallback);
  const sorted = [...new Set(files)].sort((a, b) => cost(b) - cost(a) || (a < b ? -1 : 1));
  const shards = Array.from({ length: total }, () => ({ load: 0, files: [] }));
  for (const f of sorted) {
    let best = shards[0];
    for (const s of shards) if (s.load < best.load) best = s;
    best.load += cost(f);
    best.files.push(f);
  }
  return shards.map((s) => s.files.sort());
}

export function parseShardArg(argv) {
  const hit = argv.find((a) => a.startsWith('--shard='));
  const m = hit && /^--shard=(\d+)\/(\d+)$/.exec(hit);
  if (!m) throw new Error('usage: shard-assign.mjs --suite=unit|soak --shard=<i>/<N>');
  const shard = Number(m[1]);
  const total = Number(m[2]);
  if (shard < 1 || shard > total) throw new Error(`shard-assign: --shard index must be 1..${total}, got ${shard}`);
  return { shard, total };
}

/** Every unit-suite test file, repo-relative with posix separators, resolved by vitest itself from vitest.config.ts. */
export async function listUnitTestFiles(repoRoot = REPO_ROOT) {
  const { createVitest } = await import('vitest/node');
  const ctx = await createVitest('test', { watch: false, run: true, root: repoRoot, config: join(repoRoot, 'vitest.config.ts') });
  try {
    const pairs = await ctx.globTestFiles([]);
    return pairs.map((p) => relative(repoRoot, Array.isArray(p) ? p[1] : p).split(sep).join('/')).sort();
  } finally {
    await ctx.close();
  }
}

/**
 * vitest takes file arguments as SUBSTRING filters, so a filter that is also a substring of another file's path
 * (`a.test.ts` vs `a.test.tsx`) would silently run that other file in this shard too. Returns the offending pairs.
 */
export function ambiguousFilters(shardFilesList, allFiles) {
  const bad = [];
  for (const f of shardFilesList) for (const other of allFiles) if (other !== f && other.includes(f)) bad.push([f, other]);
  return bad;
}

/** Fold vitest `--reporter=json` reports into `{ repoRelativeFile: seconds }` (largest sample wins per file). */
export function timingsFromReports(reports, repoRoot = REPO_ROOT) {
  const out = {};
  for (const report of reports) {
    for (const r of report.testResults ?? []) {
      const rel = relative(repoRoot, r.name).split(sep).join('/');
      const secs = Math.max(0, (r.endTime - r.startTime) / 1000);
      if (Number.isFinite(secs)) out[rel] = Math.max(out[rel] ?? 0, Math.round(secs * 100) / 100);
    }
  }
  return out;
}

async function main(argv) {
  const suite = (argv.find((a) => a.startsWith('--suite=')) ?? '').slice('--suite='.length);
  if (suite !== 'unit' && suite !== 'soak') throw new Error('usage: shard-assign.mjs --suite=unit|soak (--shard=<i>/<N> | --update=<json,...>)');

  const update = argv.find((a) => a.startsWith('--update='));
  if (update) {
    const reports = update.slice('--update='.length).split(',').filter(Boolean).map((p) => JSON.parse(readFileSync(p, 'utf8')));
    const all = loadTimings();
    all[suite] = Object.fromEntries(Object.entries(timingsFromReports(reports)).sort(([a], [b]) => (a < b ? -1 : 1)));
    writeFileSync(TIMINGS_FILE, `${JSON.stringify({ _doc: 'Measured seconds per test file, used by scripts/ci/shard-assign.mjs to balance CI shards. Refresh with --update.', ...all }, null, 1)}\n`);
    process.stdout.write(`updated ${suite}: ${Object.keys(all[suite]).length} files\n`);
    return 0;
  }

  const { shard, total } = parseShardArg(argv);
  let files;
  if (suite === 'unit') {
    files = await listUnitTestFiles();
  } else {
    const { listAllSoakFiles } = await import('../conveyor/soak/shard-files.mjs');
    files = listAllSoakFiles();
  }
  const mine = assignByTime(files, loadTimings()[suite], total)[shard - 1];
  if (suite === 'unit') {
    const bad = ambiguousFilters(mine, files);
    if (bad.length) throw new Error(`shard-assign: filter is a substring of another test path: ${bad.map(([a, b]) => `${a} in ${b}`).join('; ')}`);
  }
  if (mine.some((f) => /\s/.test(f))) throw new Error('shard-assign: a test path contains whitespace; the workflow cannot pass it as a filter');
  process.stdout.write(mine.length ? `${mine.join('\n')}\n` : '');
  return 0;
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_CLI) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (e) => { process.stderr.write(`${e.message}\n`); process.exitCode = 2; },
  );
}
