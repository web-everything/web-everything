#!/usr/bin/env node
/**
 * @file run-shard.mjs — #4200-ish CI speed-up (card x0zg44l). CLI: `node scripts/conveyor/soak/run-shard.mjs
 * --shard=<i>/<N>`. Resolves shard `i` of `N`'s file list via `shard-files.mjs` and runs it through
 * `vitest.soak.config.ts` — the same config `npm run test:soak` uses, just handed an explicit file list instead
 * of its own `include` glob (vitest runs exactly the files given on argv when any are given).
 *
 * Wired as `npm run test:soak:shard -- --shard=<i>/<N>` (see package.json), mirroring `test:coverage:shard`'s
 * `-- --shard=i/N` convention for the unit suite's `test-shard` matrix. `.github/workflows/ci.yml`'s `soak-shard`
 * matrix job calls it once per matrix entry; the `daemon-soak` aggregator job requires all of them.
 *
 * A shard with zero assigned files (more shards than break files) is a clean, logged no-op success — not an
 * error — so the shard count can grow ahead of the break count without turning red.
 */

import { spawnSync } from 'node:child_process';
import { shardFiles, parseShardArg, REPO_ROOT } from './shard-files.mjs';
import { admittedArgv } from '../../readiness/heavy-admission.mjs';

function main(argv) {
  const { shard, total } = parseShardArg(argv, 'usage: run-shard.mjs --shard=<i>/<N>');
  const files = shardFiles({ shard, total });

  if (!files.length) {
    process.stdout.write(`soak shard ${shard}/${total}: no scenario files assigned to this shard — nothing to run.\n`);
    return 0;
  }

  process.stdout.write(`soak shard ${shard}/${total}: running ${files.length} file(s):\n${files.map((f) => `  ${f}`).join('\n')}\n`);
  // heavy-enforce: takes a heavy-admission slot itself, so a direct `node run-shard.mjs` is queued too; under
  // `npm run test:soak:shard` (already admitted) the wrapper sees WE_HEAVY_ADMISSION_HELD and passes through.
  const admitted = admittedArgv('npx', ['vitest', 'run', '--config', 'vitest.soak.config.ts', ...files]);
  const result = spawnSync(admitted.file, admitted.args, {
    stdio: 'inherit',
    cwd: REPO_ROOT,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

process.exitCode = main(process.argv.slice(2));
