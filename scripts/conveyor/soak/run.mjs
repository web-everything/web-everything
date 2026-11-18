#!/usr/bin/env node
/**
 * @file run.mjs — #4075 daemon soak harness CLI (card x0zg44l).
 *
 *   node scripts/conveyor/soak/run.mjs soak [--rounds=25] [--seed=1] [--main-every=4]
 *       The long soak: the real review + fix daemons against the default PR fleet, origin/main moving, sessions
 *       misbehaving; the invariants checked after every tick. Exit 1 on any violation.
 *   node scripts/conveyor/soak/run.mjs break <id>
 *       One regression scenario (see breaks/index.mjs). Exit 1 when the break reproduces (RED), 0 when it does
 *       not (GREEN).
 *   node scripts/conveyor/soak/run.mjs list
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runSoak } from './soak.mjs';
import { BREAKS, breakById } from './breaks/index.mjs';
import { knownUnfixed, soakBehaviourOptions } from './known-breaks.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');

function flag(argv, name, fallback) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

export async function runLongSoak({ rounds = 25, seed = 1, mainEvery = 4, log } = {}) {
  const opts = soakBehaviourOptions(REPO_ROOT, { log });
  return runSoak({ name: 'daemon-soak', rounds, seed, mainEvery, churnEvery: 3, pinRoundClock: true, ...opts, log });
}

async function main(argv) {
  const [cmd, arg] = argv;
  if (cmd === 'list') {
    for (const b of BREAKS) {
      process.stdout.write(`${b.id.padEnd(28)} ${b.fixPresent(REPO_ROOT) ? 'fix present ' : 'FIX ABSENT  '} ${b.title} (${b.card}; fixed by ${b.fixedBy.sha} on ${b.fixedBy.where})\n`);
    }
    for (const k of knownUnfixed(REPO_ROOT)) process.stdout.write(`known-unfixed on this tree: ${k}\n`);
    return 0;
  }
  if (cmd === 'soak') {
    const report = await runLongSoak({
      rounds: Number(flag(argv, 'rounds', 25)), seed: Number(flag(argv, 'seed', 1)), mainEvery: Number(flag(argv, 'main-every', 4)),
    });
    return report.violations.length ? 1 : 0;
  }
  if (cmd === 'break') {
    const b = breakById(arg);
    process.stdout.write(`break ${b.id}: ${b.title}\n  card: ${b.card}; fixed by ${b.fixedBy.sha} on ${b.fixedBy.where}; fix present in this tree: ${b.fixPresent(REPO_ROOT)}\n`);
    const report = await b.run({});
    const problems = b.judge(report);
    // Not every break's `run()` drives the full `runSoak(...)` scenario shape (many are lighter, custom
    // scenarios — see this file's own header) — `report.ticks` is only ever present on the ones that do. A
    // GREEN print that assumed it crashed `run.mjs break <id>` outright for every other break (found running
    // `red-green.mjs` on one of them), silently defeating the RED-before/GREEN-after proof this CLI exists for.
    const ticksNote = Array.isArray(report?.ticks) ? `${report.ticks.length} ticks, ` : '';
    process.stdout.write(problems.length
      ? `RED — break ${b.id} reproduced:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`
      : `GREEN — break ${b.id} did not reproduce (${ticksNote}invariants held)\n`);
    return problems.length ? 1 : 0;
  }
  process.stderr.write('usage: run.mjs soak [--rounds=N --seed=N --main-every=N] | break <id> | list\n');
  return 2;
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`soak: fatal: ${e?.stack || e}\n`); process.exitCode = 2; });
}
