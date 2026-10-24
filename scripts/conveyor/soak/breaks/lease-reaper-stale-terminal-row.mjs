/**
 * PR #5848 incident: a ninety-second-old fix-5848 lease is condemned by two retained
 * stopped Claude rounds whose numeric startedAt values predate the live fix claim.
 * Their dead PIDs describe earlier rounds, not the current fixer. Exercise the real
 * signal builder and reap planner in the soak clone; omitting staleTerminalNames
 * replays the pre-fix session-gone reap against exactly the same evidence.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runSoak } from '../soak.mjs';

const SESSION = 'fix-5848';

export default {
  id: 'lease-reaper-stale-terminal-row',
  title: 'a fresh fixer lease survives dead stopped rows that started before its live fix-dispatch claim',
  card: 'PR #5848 incident',
  fixedBy: { sha: '555d53ca30', where: 'main' },
  fixPresent(root) {
    try {
      return readFileSync(join(root, 'scripts/conveyor/lease-reaper.mjs'), 'utf8').includes('export function staleTerminalNamesForClaims');
    } catch {
      return false;
    }
  },
  run({ log } = {}) {
    return runSoak({
      name: 'break:lease-reaper-stale-terminal-row',
      rounds: 1,
      daemons: [],
      mainEvery: 0,
      fleet: false,
      scorecards: false,
      junkInCwd: false,
      log,
      setup() {
        return { checked: false };
      },
      async perRound(w, round, ctx, api) {
        const reaper = await import(pathToFileURL(join(w.simCloneRoot, 'scripts/conveyor/lease-reaper.mjs')).href);
        const nowMs = Date.parse('2026-10-24T12:00:00.000Z');
        const claimedAtMs = nowMs - 95_000;
        const agents = [120_000, 110_000].map((age, i) => ({
          kind: 'background', name: SESSION, state: 'stopped',
          sessionId: `previous-claude-round-${i}`, pid: 2147483647,
          startedAt: nowMs - age, // epoch milliseconds, as emitted by claude agents
        }));
        const claims = [{ meta: {
          repo: 'we', kind: 'fix', pr: 5848,
          claimedAt: new Date(claimedAtMs).toISOString(),
          sessionId: 'current-fixer-round',
        } }];
        const candidate = {
          pool: 'web-everything', lane: 1, dir: w.simCloneRoot, repoKey: 'we',
          lease: {
            session: SESSION, acquiredAt: new Date(nowMs - 90_000).toISOString(),
            ttlMinutes: 240, purpose: 'conveyor-fix',
          },
        };
        const signals = {
          prStatesByRepo: new Map(),
          sessionStates: reaper.sessionStateByName(agents),
          sessionPidAlive: reaper.sessionPidAliveByName(agents, { isPidAlive: () => false }),
          sessionAgents: agents,
          wrapperPids: new Map(),
          claimRunnerPids: new Map(), // no live runner PID may mask the stale-row bug
          nowMs,
        };
        const planFor = (options) => reaper.reapPlan([candidate], {
          nowMs, signalsFor: reaper.buildLeaseSignalsFor(options),
        });
        // Negative control: the pre-fix wiring ignores the live claim's stale rows.
        const before = planFor(signals);
        ctx.before = before;
        if (signals.sessionPidAlive.get(SESSION) !== false || before.keep.length !== 0
            || before.reap.length !== 1 || before.reap[0].lease.session !== SESSION
            || before.reap[0].reason !== 'session-gone') {
          api.violation('scenario-ran', 'ignoring staleTerminalNames did not reproduce the dead-PID session-gone reap');
          return;
        }
        // Missing helper on a pre-fix tree must reproduce the break, never skip it.
        const staleTerminalNames = reaper.staleTerminalNamesForClaims?.(agents, claims) ?? new Set();
        const report = planFor({ ...signals, staleTerminalNames });
        ctx.checked = true;
        ctx.report = report;
        api.say(`r00 lease-reaper: pre-fix=${before.reap[0].reason} staleNames=${staleTerminalNames.size} reap=${report.reap.length} keep=${report.keep.length}`);
        if (report.reap.length !== 0 || report.keep.length !== 1
            || report.keep[0].lease.session !== SESSION || !staleTerminalNames.has(SESSION)) {
          api.violation('stale-terminal-lease-reaped', 'fix-5848 was not kept despite both stopped rows predating its live claim');
        }
      },
    });
  },
  judge(report) {
    const problems = report.violations.map((v) => `${v.daemon ?? '-'} tick ${v.tick ?? '-'}: [${v.invariant}] ${v.detail}`);
    if (!report.ctx?.checked || !report.ctx?.report) problems.push('[scenario-ran] the lease-reaper pass produced no usable report');
    return problems;
  },
};
