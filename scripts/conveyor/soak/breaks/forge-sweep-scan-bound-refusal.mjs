/** Entry scan limits preserve unproven trees without failing the Forge timer. */
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import fs from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
export function probeSweepScanBound(root = REPO_ROOT) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import {runSweepScanBoundCase} from ${JSON.stringify(import.meta.url)};
    console.log(JSON.stringify(await runSweepScanBoundCase(${JSON.stringify(root)})));
  `], {encoding: 'utf8', timeout: 15000, maxBuffer: 65536});
  if (child.error || child.status !== 0) return {violations: ['sweep probe failed'], detail: child.error?.message ?? child.stderr};
  try { return JSON.parse(child.stdout); }
  catch { return {violations: ['sweep probe returned unreadable evidence']}; }
}

export async function runSweepScanBoundCase(root) {
  const {sweep} = await import(pathToFileURL(join(root, 'scripts/readiness/forge-exec-sweep.mjs')));
  const {runSweepFixture} = await import(pathToFileURL(join(root, 'scripts/readiness/__tests__/fixtures/forge-sweep.mjs')));
  const scratch = mkdtempSync(join(process.env.TMPDIR, 'soak-forge-scan-bound-'));
  const runRoot = join(scratch, 'runs'), receipts = join(scratch, 'receipts');
  const run = n => 'r-' + String(n).padStart(32, '0');
  const large = join(runRoot, 'slot-1', run(1)), small = join(runRoot, 'slot-1', run(2));
  const exists = path => fs.stat(path).then(() => true, () => false);
  try {
    await fs.mkdir(large, {recursive: true}); await fs.mkdir(small); await fs.mkdir(receipts);
    await fs.writeFile(join(large, 'a'), 'a'); await fs.writeFile(join(large, 'b'), 'b');
    const old = new Date(Date.now() - 100 * 3600000);
    for (const path of [join(large, 'a'), join(large, 'b'), large, small]) await fs.utimes(path, old, old);
    const summary = await sweep({root: runRoot, receipts, apply: true, budget: {slots: {scanEntryBound: 1}}});
    const violations = [];
    if (summary.refusals.length) violations.push('entry bound failed the sweep');
    if (!summary.partial?.some(note => note.consumer === 'slots' && note.reason === 'tree scan bound exceeded')) violations.push('missing partial scan note');
    if (!await exists(large)) violations.push('unproven tree removed');
    if (await exists(small)) violations.push('next proven tree was not reclaimed');
    // Exercise the production CLI independently, lowering only the walker argv to keep this soak cheap.
    const cli = runSweepFixture(scratch, {runRoot, pythonMatch: 'result = dict(newest',
      pythonBefore: "import sys\nsys.argv[3] = '1'"});
    if (cli.status !== 0 || cli.summary?.refusals.length) violations.push('partial CLI failed the timer');
    if (!cli.stderr.includes('forge-exec-sweep: partial (')) violations.push('CLI omitted partial warning');
    if (!await exists(large)) violations.push('CLI removed unproven tree');
    return {violations, exitCode: cli.status, partial: summary.partial};
  } finally { rmSync(scratch, {recursive: true, force: true}); }
}

export default {
  id: 'forge-sweep-scan-bound-refusal',
  title: 'an oversized Forge tree is preserved with a partial note while the timer succeeds',
  card: 'Forge sweep scan-bound refusal, 2026-11-18',
  fixedBy: {sha: 'HEAD', where: 'working tree', paths: ['scripts/readiness/forge-exec-sweep.mjs']},
  fixPresent(root) { return probeSweepScanBound(root).violations.length === 0; },
  async run() { return probeSweepScanBound(); },
  judge: report => report.violations,
};
