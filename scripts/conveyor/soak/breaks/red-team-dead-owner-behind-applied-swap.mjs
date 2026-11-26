/** Behaviour decides the break: drive the real review-job admission, not a planner replay. */
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const MODULE = 'scripts/conveyor/soak/breaks/red-team-dead-owner-behind-applied-swap.mjs';
export default {
  id: 'red-team-dead-owner-behind-applied-swap',
  title: 'a dead owner behind an applied accept swap reaches real job admission once',
  card: 'REDTEAM-HOLD-APPLIED-EFFECT',
  fixedBy: { sha: 'working-tree', where: 'current tree', paths: [
    'scripts/lib/drain-red-team-evidence.mjs', 'scripts/lib/review-red-team-on-skip.mjs',
    'scripts/operations/review-job.mjs', 'scripts/lib/review-record-retry-evidence.mjs',
  ] },
  fixPresent(root) {
    // Execute admission in the requested tree; source markers cannot decide this break.
    const script = `const {default:b}=await import(${JSON.stringify(pathToFileURL(join(root, MODULE)).href)});
      process.exitCode=b.judge(await b.run({sourceRoot:${JSON.stringify(root)}})).length?1:0;`;
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root, env: { ...process.env, WE_UNDER_TEST: '1' }, encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024,
    });
    return probe.status === 0;
  },
  async run({ sourceRoot = ROOT } = {}) {
    const { appliedSwapFixture } = await import(pathToFileURL(join(sourceRoot, 'scripts/conveyor/soak/fixtures/applied-swap-recovery.mjs')).href);
    const f = appliedSwapFixture();
    try {
      const before = f.runBytes(), row = f.decide();
      if (row.action !== 'dispatch' || row.mode !== 'fresh') return { violations: ['dead owner remains held'] };
      if (!f.abandon().ok) return { violations: ['abandon refused'] };
      let second;
      const first = f.attempt(f.makeJobIo(), () => { second = f.attempt(f.makeJobIo()); });
      const good = first.redTeam?.status === 'ran' && second?.outcome === 'blocked-on-infra'
        && f.attempts.spawns === 1 && f.runBytes() === before;
      return { violations: good ? [] : ['real admission failed to admit exactly one job with review untouched'] };
    } catch (error) { return { violations: [error.message] }; }
    finally { f.close(); }
  },
  judge: report => report.violations,
};
