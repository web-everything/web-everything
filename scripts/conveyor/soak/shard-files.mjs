/**
 * @file shard-files.mjs — #4200-ish CI speed-up (card x0zg44l's own harness). Deterministic file-level sharding
 * for `npm run test:soak`, used by `.github/workflows/ci.yml`'s `soak-shard` matrix.
 *
 * Card 11 (perf sweep 2026-10-07): files are assigned to shards by MEASURED time (`scripts/ci/test-timings.json`,
 * greedy longest-first, `scripts/ci/shard-assign.mjs`). The old split pinned the 50-tick baseline alone in shard 1 and
 * round-robined the breaks by sorted index, blind to cost, so the soak shards ran 4.9-13.4 min. A file with no stored
 * timing gets the median, so a new break (one file, discovered from disk — never from `breaks/index.mjs`'s registry)
 * lands in a shard automatically with no shard-list edit.
 */

import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assignByTime, loadTimings } from '../../ci/shard-assign.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..', '..');
export const BASELINE_FILE = join(HERE, 'daemon-soak.soak.test.mjs');
export const BREAKS_DIR = join(HERE, 'breaks');

/** Every `breaks/*.soak.test.mjs` scenario file, sorted for a deterministic, stable round-robin. */
export function listBreakTestFiles(breaksDir = BREAKS_DIR) {
  return readdirSync(breaksDir)
    .filter((f) => f.endsWith('.soak.test.mjs'))
    .sort()
    .map((f) => join(breaksDir, f));
}

function toRepoRelative(absPath, repoRoot) {
  return relative(repoRoot, absPath).split(sep).join('/');
}

/**
 * The vitest-CLI-ready file list (repo-root-relative, posix separators) for one shard.
 *
 * `shard` is 1-based. `total === 1` runs everything (baseline + all breaks) — the single-shard fallback used by
 * `npm run test:soak` (no sharding) and by a local "does the split still work" smoke check. Otherwise the
 * baseline and every break are balanced across the shards by measured time.
 */
export function listAllSoakFiles({ breaksDir = BREAKS_DIR, baselineFile = BASELINE_FILE, repoRoot = REPO_ROOT } = {}) {
  return [baselineFile, ...listBreakTestFiles(breaksDir)].map((f) => toRepoRelative(f, repoRoot));
}

export function shardFiles({ shard, total, breaksDir = BREAKS_DIR, baselineFile = BASELINE_FILE, repoRoot = REPO_ROOT, timings = loadTimings().soak } = {}) {
  if (!Number.isInteger(total) || total < 1) throw new Error(`soak shard-files: --shard total must be a positive integer, got "${total}"`);
  if (!Number.isInteger(shard) || shard < 1 || shard > total) throw new Error(`soak shard-files: --shard index must be 1..${total}, got "${shard}"`);

  // total === 1 runs everything; otherwise greedy longest-first by measured time (see scripts/ci/shard-assign.mjs).
  // A file with no stored timing gets the median, so a new break lands in a shard with no list to edit.
  const all = listAllSoakFiles({ breaksDir, baselineFile, repoRoot });
  return total === 1 ? all : assignByTime(all, timings, total)[shard - 1];

}

/** Parses `--shard=i/N` out of an argv array. Throws with a usage line if missing or malformed. */
export function parseShardArg(argv, usage = 'usage: --shard=<i>/<N>') {
  const hit = argv.find((a) => a.startsWith('--shard='));
  if (!hit) throw new Error(usage);
  const m = /^--shard=(\d+)\/(\d+)$/.exec(hit);
  if (!m) throw new Error(`${usage} (got "${hit}")`);
  return { shard: Number(m[1]), total: Number(m[2]) };
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  try {
    const { shard, total } = parseShardArg(process.argv.slice(2), 'usage: shard-files.mjs --shard=<i>/<N>');
    const files = shardFiles({ shard, total });
    process.stdout.write(files.length ? `${files.join('\n')}\n` : '');
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = 2;
  }
}
