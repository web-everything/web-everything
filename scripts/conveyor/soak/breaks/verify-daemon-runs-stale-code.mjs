/**
 * @file breaks/verify-daemon-runs-stale-code.mjs — live break, 2026-10-04. A fix rebuilt into the verify daemon's
 * clone never reached the running daemon.
 *
 * LIVE INCIDENT: the verify daemon (launchd `com.we.verify-daemon`, clone `wev-control`) had run 25 h on one
 * in-memory tree, with no self-sync. When PR #3902's ENOTDIR fix was rebuilt into `wev-control` (16:39Z), the files
 * on disk changed but the running sweep kept failing every tick until an agent kickstarted it by hand (16:44Z).
 *
 * FIX — `skills-src/conveyor/verify-daemon.mjs`: `runDaemonLoop` takes `codeChanged` and stops with
 * `stoppedReason: 'code-changed'` after the tick in which `cloneHeadChanged` sees the clone HEAD move; `main()`
 * then releases the lease and exits, and launchd KeepAlive relaunches it on the new tree.
 *
 * SCENARIO: the loop ticks with a clone whose HEAD moves after tick 2, wired the way `main()` wires it. RED = the
 * loop keeps ticking (stale code) through all 8 ticks. GREEN = it stops with `code-changed` right after tick 2.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_TICKS = 8;

export default {
  id: 'verify-daemon-runs-stale-code',
  title: 'the verify daemon kept running its old in-memory code after a fix was rebuilt into its clone',
  card: 'verify-daemon never reloads — live #3902 rollout, 2026-10-04 (PR #3903)',
  fixedBy: { sha: '06633598f', where: 'lane/verify-pool-scan-non-dir', paths: ['skills-src/conveyor/verify-daemon.mjs'] },
  fixPresent(root) {
    const p = join(root, 'skills-src/conveyor/verify-daemon.mjs');
    return existsSync(p) && readFileSync(p, 'utf8').includes('export function cloneHeadChanged');
  },
  async run({ log } = {}) {
    const mod = await import('../../../../skills-src/conveyor/verify-daemon.mjs');
    let head = 'boot-sha';
    let ticks = 0;
    const tickOnce = async () => { ticks += 1; if (ticks === 2) head = 'rebuilt-sha'; return { dispatched: [], failures: [] }; };
    const readHead = () => head;
    const codeChanged = mod.cloneHeadChanged ? () => mod.cloneHeadChanged({ bootHead: 'boot-sha', readHead }) : () => false;
    const out = await mod.runDaemonLoop({ tickOnce, sleep: async () => {}, codeChanged, maxTicks: MAX_TICKS });
    log?.(JSON.stringify(out));
    const violations = [];
    if (out.stoppedReason !== 'code-changed' || out.ticks !== 2) {
      violations.push({ invariant: 'stale-code', detail: `clone HEAD moved after tick 2, but the daemon ran ${out.ticks} tick(s) on its old code and stopped with ${out.stoppedReason}` });
    }
    return { violations, out };
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
