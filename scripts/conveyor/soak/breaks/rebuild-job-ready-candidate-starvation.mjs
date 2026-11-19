/**
 * @file breaks/rebuild-job-ready-candidate-starvation.mjs — ticks queued another long smoke instead of
 * adopting a passed candidate when main advanced. A detached job also waited on its target daemon's read slot.
 * Exercise the real tick entry point from the tree under test with isolated ready records and job stores.
 * Inject only adoption and reattachment: no smoke or detached process may start in this replay.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runSoak } from '../soak.mjs';

export default {
  id: 'rebuild-job-ready-candidate-starvation',
  title: 'rebuild ticks adopt ready candidates before reattaching and never enqueue another smoke over ready evidence',
  card: 'rebuild-job ready-candidate starvation',
  fixedBy: {
    sha: 'rebuild-job-ready-candidate-starvation',
    where: 'lane/rebuild-job-ready-candidate-starvation',
    paths: ['scripts/lib/daemon-rebuild/rebuild-job.mjs', 'scripts/lib/daemon-rebuild/rebuild.mjs'],
  },
  fixPresent(root) {
    try {
      const source = readFileSync(join(root, 'scripts/lib/daemon-rebuild/rebuild-job.mjs'), 'utf8');
      return /r\?\.moved \|\| r\?\.adopted/.test(source) && /readReadyCandidate\(root, env\)/.test(source);
    } catch {
      return false;
    }
  },
  async run({ log } = {}) {
    return runSoak({
      name: 'break:rebuild-job-ready-candidate-starvation',
      rounds: 1,
      daemons: [],
      mainEvery: 0,
      fleet: false,
      log,
      setup() { return {}; },
      async perRound(w, round, ctx, api) {
        const load = (path) => import(pathToFileURL(join(w.simCloneRoot, path)).href);
        const job = await load('scripts/lib/daemon-rebuild/rebuild-job.mjs');
        const { createJobStore, enqueueJob } = await load('scripts/lib/daemon-jobs-runtime.mjs');
        const { markSucceeded } = await load('scripts/lib/daemon-jobs.mjs');
        const { writeReadyCandidate, readReadyCandidate } = await load('scripts/lib/daemon-rebuild/state.mjs');
        const { targetDaemonReader } = await load('scripts/lib/daemon-rebuild/rebuild.mjs');
        const scratch = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'soak-rebuild-ready-'));
        const check = (ok, invariant, detail) => { if (!ok) api.violation(invariant, detail); };
        try {
          // A passed candidate is older than the latest main tip throughout these tick passes.
          for (const mode of ['moved', 'adopted', 'ready-idle', 'ready-reattach', 'needs-build']) {
            const root = join(scratch, mode);
            const env = { WE_DAEMON_STATE_DIR: join(root, 'state') };
            const store = createJobStore(join(root, 'jobs'));
            mkdirSync(store.dir, { recursive: true });
            const ready = { kind: 'candidate', prevHead: 'a'.repeat(40), tree: 'passed-tree',
              passedAt: new Date().toISOString(), adopt: { finalSha: 'b'.repeat(40), applied: [] } };
            const publish = () => {
              if (!writeReadyCandidate(root, ready, env) || !readReadyCandidate(root, env)) {
                throw new Error(`${mode}: failed to seed ready evidence`);
              }
            };
            if (mode !== 'needs-build') publish();
            const recovering = mode === 'moved' || mode === 'adopted' || mode === 'ready-reattach';
            const old = recovering ? enqueueJob({ store, kindDef: job.REBUILD_JOB_KIND,
              codeSha: 'a'.repeat(40), input: { root } }) : null;
            const before = store.list().records.map(r => r.id);
            const calls = [];
            const result = await job.rebuildCloneAsJob({
              root, env, store, codeSha: 'a'.repeat(40),
              settings: { minIntervalMs: 0, minIntervalJitterPct: 0 },
              log: { error() {} }, evict: () => ({}),
              adopt: async () => {
                calls.push('adopt');
                return mode === 'moved' || mode === 'adopted'
                  ? { [mode]: true, reason: 'ready-adopted' }
                  : { reason: 'needs-build', plan: { finalSha: 'c'.repeat(40) } };
              },
              reattach: async () => {
                calls.push('reattach');
                if (mode === 'ready-reattach') {
                  publish();
                  store.update(old.id, r => markSucceeded(r, { at: new Date().toISOString() }));
                }
              },
            });
            const records = store.list().records;
            check(calls[0] === 'adopt' && calls.filter(c => c === 'adopt').length === 1,
              'adoption-order', `${mode}: calls=${JSON.stringify(calls)}`);
            if (mode === 'needs-build') {
              check(result.reason === 'rebuild-job-started' && records.length === 1,
                'missing-ready-must-build', `no ready evidence: reason=${result.reason}, jobs=${records.length}`);
              const reader = records[0]?.input?.daemonReader;
              // The simulator cannot probe the host process table. Supply a deterministic session clock,
              // retaining the real queue's clone/owner/pid binding and the real child-env transport.
              const session = { ...reader, startedMs: 123456 };
              const childEnv = job.rebuildChildEnv({}, { ppid: 0, daemonReader: session });
              const startTimeOf = pid => pid === process.pid ? session.startedMs : null;
              const owners = targetDaemonReader(childEnv.WE_DAEMON_REBUILD_READER, root, startTimeOf);
              check(!!reader && owners.length === 1 && owners[0] === reader.owner,
                'target-reader-not-excluded', 'queued job must carry its target daemon session through to the reader exclusion');
              check(targetDaemonReader(childEnv.WE_DAEMON_REBUILD_READER, join(root, 'other'), startTimeOf).length === 0
                && targetDaemonReader(childEnv.WE_DAEMON_REBUILD_READER, root, () => null).length === 0,
                'unknown-target-reader-excluded', 'a mismatched clone must retain the reader');
            } else {
              check(JSON.stringify(records.map(r => r.id)) === JSON.stringify(before),
                'ready-candidate-enqueued-again', `${mode}: reason=${result.reason}, jobs=${records.length}, before=${before.length}`);
              if (mode === 'moved' || mode === 'adopted') {
                check(result[mode] === true && calls.length === 1,
                  'adopted-candidate-reattached', `${mode}: reason=${result.reason}, calls=${JSON.stringify(calls)}`);
              } else {
                check(result.reason === 'ready-pending' && !!readReadyCandidate(root, env),
                  'ready-evidence-lost', `${mode}: reason=${result.reason}`);
                check(calls.length === (recovering ? 2 : 1),
                  'ready-job-recovery-skipped', `${mode}: calls=${JSON.stringify(calls)}`);
              }
            }
            api.say(`${mode}: ${result.reason}, calls=${calls.join(' -> ')}, jobs=${records.length}`);
          }
        } finally {
          rmSync(scratch, { recursive: true, force: true });
        }
      },
    });
  },
  judge(report) {
    return [
      ...(report.fatal ? [`[crash] ${report.fatal}`] : []),
      ...report.violations.map(v => `${v.daemon ?? '-'} tick ${v.tick ?? '-'}: [${v.invariant}] ${v.detail}`),
    ];
  },
};
