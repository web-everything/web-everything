/**
 * PR #5848 sat quiet for 53 minutes after its fixer died and its PID was recycled
 * into `claude bg-spare --bg-spare <sock>`. PID existence kept the stale fix
 * session/claim live forever. PR #5880 makes reconcile check process identity.
 *
 * Four fix-dispatch ticks exercise the real daemon against a working fix-<P>
 * row with a REAL live bg-spare PID. The row is recent, so age-based reaping
 * cannot rescue the pre-fix case. Only a NEW fix session counts as dispatch.
 * No scripted agent behaviors run: the stale row cannot push, crash or finish.
 * The simulator host omits main()'s claim-refresh wrapper, so each tick explicitly
 * runs that real wrapper first. Guards require ps, listing/probe/claim evidence
 * and an observed dispatch decision. The bounded failure names the stuck PR/session for operator investigation.
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { scenario, runScenario } from '../../__tests__/sim/scenario.mjs';
import { sessionMatches } from '../invariants.mjs';
import { FALLBACK_REQUIRED_STATUS_CHECKS } from '../../../lib/required-status-checks.mjs';
import { fullSessionId, shortId, withStoreLock } from '../../../operations/__tests__/helpers/fake-claude-shim.mjs';

const ROUNDS = 4;
const SPARE_ARGV = 'claude bg-spare --bg-spare /tmp/x.sock';
// Run clone-owned readers/writers with the world's isolated HOME, clock and tools.
function inClone(w, source, args = []) {
  return execFileSync(process.execPath, ['--input-type=module', '-e', source, ...args], {
    cwd: w.simCloneRoot, env: { ...process.env, ...w.env }, encoding: 'utf8',
    timeout: 60_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export default {
  id: 'recycled-pid-bg-spare-fix-claim',
  title: 'a recycled bg-spare PID cannot hold a dead fixer session live forever',
  card: 'PR #5880',
  fixedBy: {
    sha: 'fe6b5a138f', where: 'main',
    paths: ['scripts/lib/pid-alive.mjs', 'scripts/conveyor/reconcile-pass.mjs'],
  },
  fixPresent(root) {
    try {
      // Fix detection must not run the behavior under test: a regression must
      // remain a required GREEN test, never turn itself into an expected failure.
      return /export function pidIdentity\(/.test(readFileSync(join(root, 'scripts/lib/pid-alive.mjs'), 'utf8'))
        && /export function probePid\([^\n]*identity = pidIdentity\b/.test(
          readFileSync(join(root, 'scripts/conveyor/reconcile-pass.mjs'), 'utf8'))
        && /export function defaultIsPidAlive\([^\n]*identity = pidIdentity\b/.test(
          readFileSync(join(root, 'scripts/conveyor/driver-watchdog.mjs'), 'utf8'));
    } catch { return false; }
  },
  async run({ log } = {}) {
    let sleeper;
    try {
      // Set the real spare's command shape before IPC readiness so ps cannot
      // mistake spare words in a Node script/argument for the subcommand.
      // The timer bounds leaks if the runner dies; finally owns cleanup.
      sleeper = spawn(process.execPath, ['-e',
        `process.title = ${JSON.stringify(SPARE_ARGV)}; setTimeout(() => process.exit(0), 300000); process.send("ready");`],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('bg-spare sleeper readiness timed out')), 5000);
        sleeper.once('message', () => { clearTimeout(timer); resolve(); });
        sleeper.once('error', error => { clearTimeout(timer); reject(error); });
        sleeper.once('exit', () => { clearTimeout(timer); reject(new Error('bg-spare sleeper exited before readiness')); });
      });
      sleeper.disconnect();
      const report = { violations: [], ticks: [], ctx: null };
      const fail = detail => report.violations.push({ invariant: 'recycled-pid-scenario', detail });
      const say = log ?? (line => process.stdout.write(`${line}\n`));
      const play = [];
      for (let round = 0; round < ROUNDS; round += 1) {
        play.push(w => {
          const ctx = report.ctx;
          process.kill(sleeper.pid, 0);
          const argv = execFileSync('ps', ['-p', String(sleeper.pid), '-o', 'command='],
            { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
          if (argv.trim() !== SPARE_ARGV) throw new Error('sleeper argv mismatch');
          ctx.psChecks += 1;
          const evidence = JSON.parse(inClone(w, `
            import { gateHost } from './scripts/lib/dispatch-throttle.mjs';
            import { enrichAgents, defaultReadAgents } from './scripts/conveyor/reconcile-pass.mjs';
            import { readLiveFixClaim } from './scripts/conveyor/fix-procedure.mjs';
            import { withFixDispatchClaimRefresh } from './skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs';
            const [id, pr] = process.argv.slice(1);
            const before = readLiveFixClaim({ repo: 'we', pr: Number(pr) });
            const row = enrichAgents(defaultReadAgents()).find(a => a.id === id);
            // main() wraps the tick this way; sim/daemon-host.mjs currently doesn't.
            await withFixDispatchClaimRefresh({ tickOnce: () => null }, {
              log: { error() {} },
            }).tickOnce();
            const after = readLiveFixClaim({ repo: 'we', pr: Number(pr) });
            process.stdout.write(JSON.stringify({ row, before, after, hostGate: gateHost() }));
          `, [ctx.staleId, String(ctx.pr)]));
          if (!evidence.hostGate?.admit || (process.platform === 'darwin'
              && (evidence.hostGate.cpuIdlePct !== 100 || evidence.hostGate.memFreePct !== 100))) {
            fail(`r${round}: calm host fixture missing; inspect daemon environment and host sample`);
          }
          ctx.hostGateChecks += 1;
          const row = evidence.row;
          if (row?.pid !== sleeper.pid || row?.sessionId !== ctx.sessionId || row?.state !== 'working' || row?.selfReportedDone || row?.hung
              || row?.authExpired || row?.idleFinished || typeof row?.pidAlive !== 'boolean') {
            fail(`r${round}: stale listing row lost its live PID or was bypassed by another finished signal`);
          }
          if (round === 0 && (evidence.before?.meta?.kind !== 'fixing'
              || evidence.before?.meta?.who !== `fix-${ctx.pr}`
              || evidence.before?.meta?.sessionId !== ctx.sessionId
              || Object.hasOwn(evidence.before?.meta ?? {}, 'runnerPid'))) {
            fail('initial fixing claim must be session-bound without a runnerPid, as acquired in production');
          }
          if (round > 0 && row?.pidAlive !== ctx.pidAlive) fail('PID verdict changed during scenario');
          ctx.pidAlive = row?.pidAlive;
          ctx.claimReleased ||= !evidence.after;
          if (evidence.after) fail(`r${round}: production refresh retained the dead fixer's session-bound fixing claim (pidAlive=${row?.pidAlive})`);
          ctx.evidenceChecks += 1;
        });
        play.push('tick fix-dispatch');
        play.push((w, api) => {
          const ctx = report.ctx;
          const tick = api.trace.at(-1);
          report.ticks.push(tick);
          const stale = w.claude.sessions().find(s => s.id === ctx.staleId);
          if (stale?.state !== 'working' || stale?.pid !== sleeper.pid || stale?.sessionId !== ctx.sessionId) {
            fail(`r${round}: stale session changed during daemon tick`);
          }
          if (!tick?.result || tick.error || tick.onTickError || tick.restart) fail(`r${round}: incomplete daemon tick`);
          const decision = tick?.result?.reconcileRefusals?.some(r =>
            Number(r.pr ?? r.prNumber) === ctx.pr && ['live-process', 'fix-claimed'].includes(r.kind));
          ctx.dispatched ||= w.claude.sessions().some(s => s.id !== ctx.staleId && sessionMatches(s.name, 'fix', ctx.pr));
          if (!ctx.dispatched && !decision) {
            const reasons = [...(tick?.result?.refusals ?? []), ...(tick?.result?.reconcileRefusals ?? [])]
              .filter(r => Number(r.pr ?? r.prNumber) === ctx.pr).map(r => r.kind).slice(0, 8);
            fail(`r${round}: no dispatch or PID/claim refusal for PR #${ctx.pr}; inspect daemon refusals: ${reasons.join(', ') || 'none'}`);
          }
          ctx.checked += 1;
          say(`r${round}: PR #${ctx.pr}, pidAlive=${ctx.pidAlive}, fixing claim released=${ctx.claimReleased}, new fix dispatched=${ctx.dispatched}, refusal=${!!decision}`);
          w.clock.advance('3m');
        });
      }
      try {
        await runScenario(scenario('break:recycled-pid-bg-spare-fix-claim', {
          repos: ['we'], lanes: 2, play,
          setup(w) {
            // runScenario forks hosts with w.env. Keep sampleHost's cache and
            // macOS probes private and calm even after its five-second TTL.
            const hostDir = join(w.root, 'calm-host');
            mkdirSync(hostDir);
            for (const [tool, output] of Object.entries({
              top: 'CPU usage: 0.0% user, 0.0% sys, 100.0% idle',
              memory_pressure: 'System-wide memory free percentage: 100%',
            })) {
              writeFileSync(join(hostDir, tool), `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, { mode: 0o755 });
            }
            Object.assign(w.env, {
              TMPDIR: hostDir, TMP: hostDir, TEMP: hostDir,
              PATH: `${hostDir}${delimiter}${w.env.PATH}`,
              // No CPU sample on Linux: disable the load-average fallback gate.
              WE_MAX_LOAD_PER_CORE: String(Number.MAX_VALUE),
              WE_MIN_MEM_FREE_PCT: '1',
            });
            const head = 'lane/soak-recycled-pid';
            w.git.createBranch('we', head, { from: 'main', files: { 'soak/recycled-pid.txt': 'fix needed\n' } });
            const pr = w.gh.openPr({ repo: 'we', head, base: 'main', title: 'soak: dead fixer with recycled PID',
              labels: ['review:changes'], body: 'No backlog item.' });
            w.gh.comment('we', pr, '1. Correct the scope guard.', { author: 'review-bot' });
            w.gh.setRequiredChecks('we', FALLBACK_REQUIRED_STATUS_CHECKS);
            w.gh.setChecks('we', pr, FALLBACK_REQUIRED_STATUS_CHECKS.map(name => ({ name, conclusion: 'SUCCESS' })));

            const id = shortId();
            withStoreLock(w.claude.env.FAKE_CLAUDE_STORE, store => {
              store.sessions.push({ id, sessionId: fullSessionId(), name: `fix-${pr}`, kind: 'background',
                state: 'working', status: 'busy', waitingFor: null, cwd: w.simCloneRoot,
                startedAt: w.clock.now(), pid: sleeper.pid });
            });
            const sessionId = w.claude.sessions().find(s => s.id === id).sessionId;
            const claim = JSON.parse(inClone(w, `
              import { acquireFixClaim } from './scripts/conveyor/fix-procedure.mjs';
              const [pr, sessionId] = process.argv.slice(1);
              const claim = acquireFixClaim({ repo: 'we', pr: Number(pr), who: 'fix-' + pr, sessionId });
              process.stdout.write(JSON.stringify(claim));
            `, [String(pr), sessionId]));
            if (!claim.ok) throw new Error('fixing claim was refused');
            report.ctx = { pr, staleId: id, sessionId, psChecks: 0, evidenceChecks: 0, hostGateChecks: 0, claimReleased: false, dispatched: false, checked: 0 };
            return report.ctx;
          },
        }), { timeoutMs: 60_000, budgetMs: 240_000 });
      } catch (error) {
        fail(`scenario incomplete; inspect PR/session and daemon evidence: ${error.message}`);
      }
      const ctx = report.ctx;
      if (ctx?.psChecks !== ROUNDS || ctx?.evidenceChecks !== ROUNDS || ctx?.hostGateChecks !== ROUNDS || ctx?.checked !== ROUNDS) {
        fail(`incomplete evidence: ps=${ctx?.psChecks ?? 0}, listing/claim=${ctx?.evidenceChecks ?? 0}, host=${ctx?.hostGateChecks ?? 0}, ticks=${ctx?.checked ?? 0}/${ROUNDS}`);
      }
      if (ctx?.checked === ROUNDS && !ctx.dispatched) {
        report.violations.push({ invariant: 'recycled-pid-live',
          detail: `PR #${ctx.pr} received no new fix after ${ROUNDS} ticks; investigate stale fix session ${ctx.staleId} holding the recycled bg-spare PID` });
      }
      say(`break verdict: ${report.violations.length ? JSON.stringify(report.violations) : 'GREEN'}`);
      return report;
    } finally {
      if (sleeper && sleeper.exitCode === null) sleeper.kill('SIGKILL');
    }
  },
  judge(report) {
    return report.violations.map(v => `[${v.invariant}] ${v.detail}`);
  },
};
