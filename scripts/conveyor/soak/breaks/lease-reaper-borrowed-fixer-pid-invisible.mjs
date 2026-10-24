/**
 * PR #5806 incident (2026-10-23): a borrowed Codex fixer holds a twenty-minute-old lease,
 * but appears in neither claude agents nor the run store. Its fresh fix-dispatch claim
 * carries the live runner PID, whose command includes the exact --session=fix-5806 token.
 * Before the fix, the resident reaper ignores that evidence and plans a session-gone reap.
 * Like the hand-briefed-owner break, exercise the real CLI in dry-run mode against an
 * isolated pool. No daemon ticks or real lane releases are needed to observe the break.
 */
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireLockDir } from '../../../readiness/file-locks.mjs';
import { fixDispatchClaimRoot, fixDispatchResource } from '../../fix-claim-store.mjs';
import { keepAliveScript } from '../../../lib/test-keepalive.mjs';
import { runSoak } from '../soak.mjs';

const MIN = 60_000;
const SESSION = 'fix-5806';

function fakeClaudeBin(root) {
  const bin = join(root, 'fakebin');
  mkdirSync(bin, { recursive: true });
  const claude = join(bin, 'claude');
  // One unrelated background row keeps the session-gone axis ON; an empty listing
  // would disable it and make the scenario pass without exercising the incident.
  const listing = [{ kind: 'background', name: 'conveyor-1', sessionId: 'unrelated-bg-session', state: 'working', startedAt: Date.now() - 60 * MIN }];
  writeFileSync(claude, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(listing)}\nJSON\n`);
  chmodSync(claude, 0o755);
  return bin;
}

export default {
  id: 'lease-reaper-borrowed-fixer-pid-invisible',
  title: 'a borrowed fixer absent from claude agents and the run store keeps its lease while its fresh claim runner PID is live and bound to its session',
  card: 'PR #5806 incident',
  fixedBy: { sha: 'd5b71e11a6ae', where: 'lane/reaper-borrowed-fixer-pid' },
  fixPresent(root) {
    try {
      return readFileSync(join(root, 'scripts/conveyor/lease-reaper.mjs'), 'utf8').includes('claimRunnerPidsBySession');
    } catch {
      return false;
    }
  },
  run({ log } = {}) {
    return runSoak({
      name: 'break:lease-reaper-borrowed-fixer-pid-invisible',
      rounds: 1,
      daemons: [],
      mainEvery: 0,
      fleet: false,
      scorecards: false,
      junkInCwd: false,
      log,
      setup() {
        const base = mkdtempSync(join(tmpdir(), 'we-soak-lease-borrowed-fixer-'));
        const poolRoot = join(base, 'pool');
        const leasePath = join(poolRoot, 'web-everything', 'lane-1', '.git', '.lane-lease');
        mkdirSync(join(poolRoot, 'web-everything', 'lane-1', '.git'), { recursive: true });
        writeFileSync(leasePath, `${JSON.stringify({
          session: SESSION,
          acquiredAt: new Date(Date.now() - 20 * MIN).toISOString(),
          ttlMinutes: 240,
          purpose: 'conveyor-fix',
        }, null, 2)}\n`);
        const runsDir = join(base, 'runs');
        mkdirSync(runsDir);
        return { base, poolRoot, leasePath, runsDir, binDir: fakeClaudeBin(base), checked: false };
      },
      async perRound(w, round, ctx, api) {
        let child;
        try {
          // argv keeps the session token literal; only this child's own PID is stopped below.
          child = spawn(process.execPath, ['-e', keepAliveScript(), '--', `--session=${SESSION}`], { stdio: 'ignore' });
          await once(child, 'spawn');
          const coordinationRoot = join(ctx.base, 'coordination');
          const resource = fixDispatchResource({ repo: 'we', kind: 'fix', pr: 5806 });
          const claimed = acquireLockDir(fixDispatchClaimRoot(coordinationRoot), resource, {
            owner: SESSION,
            path: resource,
            pid: child.pid,
            heartbeatAt: new Date().toISOString(),
            meta: { repo: 'we', kind: 'fix', pr: 5806, borrowed: true, runnerPid: child.pid },
          });
          if (!claimed) {
            api.violation('scenario-ran', 'could not seed the borrowed fixer claim');
            return;
          }
          const env = {
            ...process.env, ...w.env,
            LANE_POOL_ROOT: ctx.poolRoot,
            WE_COORDINATION_ROOT: coordinationRoot,
            OPERATION_RUNS_DIR: ctx.runsDir, // deliberately empty: no pid:<n> run record
            PATH: `${ctx.binDir}:${process.env.PATH}`,
          };
          const script = join(w.simCloneRoot, 'scripts/conveyor/lease-reaper.mjs');
          const r = spawnSync(process.execPath, [script, '--dry-run', '--json', '--no-check-prs'], {
            encoding: 'utf8', env, timeout: 20_000, maxBuffer: 1024 * 1024,
          });
          ctx.checked = true;
          let report;
          try { report = JSON.parse(r.stdout); } catch { /* refused below */ }
          if (r.error || r.status !== 0 || !report || report.scanned !== 1 || report.sessionAxis !== 'on'
              || !Array.isArray(report.wouldReap) || !Number.isInteger(report.kept)) {
            api.violation('scenario-ran', 'lease-reaper did not produce a successful one-lease report with the session-gone axis on');
            return;
          }
          ctx.report = report;
          api.say(`r00 lease-reaper --dry-run: scanned=${report.scanned} wouldReap=${JSON.stringify(report.wouldReap)} kept=${report.kept} sessionAxis=${report.sessionAxis}`);
          if (!existsSync(ctx.leasePath) || report.wouldReap.some((c) => c.session === SESSION)) {
            api.violation('borrowed-fixer-lease-reaped', 'fix-5806 was reaped despite a fresh claim carrying its live, session-bound runner PID');
          } else if (report.kept !== 1 || report.wouldReap.length !== 0) {
            api.violation('scenario-ran', 'lease-reaper did not account for the borrowed fixer lease as kept');
          }
        } finally {
          try {
            if (child?.pid && child.exitCode === null && child.signalCode === null) {
              const exited = once(child, 'exit');
              child.kill('SIGKILL');
              await exited;
            }
          } finally {
            rmSync(ctx.base, { recursive: true, force: true });
          }
        }
      },
    });
  },
  judge(report) {
    const own = new Set(['borrowed-fixer-lease-reaped', 'scenario-ran']);
    const problems = report.violations.filter((v) => own.has(v.invariant))
      .map((v) => `${v.daemon ?? '-'} tick ${v.tick ?? '-'}: [${v.invariant}] ${v.detail}`);
    if (!report.ctx?.checked || !report.ctx?.report) problems.push('[scenario-ran] the resident lease-reaper pass produced no usable report');
    return problems;
  },
};
