/** Replay spacing against the actual job function in the tree under test; never start a child job. */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { runSoak } from '../soak.mjs';

export async function replayUrgent(tree, urgent) {
  const load = path => import(pathToFileURL(join(tree, path)).href);
  const { rebuildCloneAsJob, REBUILD_JOB_KIND } = await load('scripts/lib/daemon-rebuild/rebuild-job.mjs');
  const { createJobStore, enqueueJob } = await load('scripts/lib/daemon-jobs-runtime.mjs');
  const { markSucceeded } = await load('scripts/lib/daemon-jobs.mjs');
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'soak-urgent-stale-'));
  try {
    const store = createJobStore(join(root, 'jobs')), now = Date.now();
    mkdirSync(store.dir, { recursive: true });
    const old = enqueueJob({ store, kindDef: REBUILD_JOB_KIND, codeSha: 'a'.repeat(40), input: { root }, now: now - 1000 });
    store.update(old.id, r => markSucceeded(r, { at: new Date(now - 100).toISOString() }));
    const result = await rebuildCloneAsJob({ root, env: { WE_DAEMON_REBUILD_STRICT_EVIDENCE: '0' },
      store, urgent, codeSha: 'a'.repeat(40), now: () => now, log: { error() {} },
      adopt: async () => ({ reason: 'needs-build' }), reattach: async () => {}, evict: () => ({}),
      settings: { minIntervalMs: 900000, minIntervalJitterPct: 0 } });
    return { reason: result.reason, jobs: store.list().records.length };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

export default {
  id: 'rebuild-job-urgent-stale-bypass',
  title: 'urgent stale refusals bypass spacing while ordinary rebuilds remain spaced',
  card: 'REVIEW-SPEED-STALE',
  fixedBy: { sha: 'rebuild-job-urgent-stale-bypass', where: 'lane/rebuild-job-urgent-stale-bypass',
    paths: ['scripts/lib/daemon-self-sync.mjs', 'scripts/lib/daemon-rebuild/rebuild.mjs', 'scripts/lib/daemon-rebuild/rebuild-job.mjs'] },
  fixPresent(root) {
    try {
      const probe = `import { replayUrgent } from ${JSON.stringify(import.meta.url)};
        const r = await replayUrgent(process.argv[1], true);
        process.exit(r.reason === 'rebuild-job-started' && r.jobs === 2 ? 0 : 1);`;
      execFileSync(process.execPath, ['--input-type=module', '-e', probe, root],
        { timeout: 15000, maxBuffer: 65536, stdio: 'pipe' });
      return true;
    } catch { return false; }
  },
  async run({ log } = {}) {
    return runSoak({ name: 'break:rebuild-job-urgent-stale-bypass', rounds: 1, daemons: [], mainEvery: 0,
      fleet: false, log, setup() { return {}; },
      async perRound(w, round, ctx, api) {
        for (const urgent of [false, true]) {
          const r = await replayUrgent(w.simCloneRoot, urgent);
          const expected = urgent ? 'rebuild-job-started' : 'rebuild-job-spaced';
          if (r.reason !== expected || r.jobs !== (urgent ? 2 : 1)) {
            api.violation('urgent-spacing', `urgent=${urgent}: ${JSON.stringify(r)}`);
          }
          api.say(`urgent=${urgent}: ${r.reason}, jobs=${r.jobs}`);
        }
      } });
  },
  judge(report) {
    return [...(report.fatal ? [`[crash] ${report.fatal}`] : []),
      ...report.violations.map(v => `[${v.invariant}] ${v.detail}`)];
  },
};
