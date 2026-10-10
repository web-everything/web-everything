/**
 * @file breaks/resource-sampler-two-writers-and-stale-config.mjs — PR #4722 (card xkuflno, resource sampler).
 * Two post-accept red-team breaks in `ensureSamplerJob`, the supervisor's "exactly one sampler job" step:
 *
 *   1. CONFIG IGNORED — a restart with a changed `--interval-ms` / `--root` found a live job on the same code
 *      sha and returned it, so the running sampler kept the OLD config for ever (the job never finishes).
 *   2. SECOND WRITER — a child that claimed its job between `store.list()` and the replacement escaped
 *      retirement: `retire` ran on the stale (handle-less) record, then the record was failed, leaving the
 *      claimed process alive and writing snapshots beside its successor.
 *
 * Fix: a live job must match BOTH sha and input; every other live job is marked failed FIRST and only then
 * retired from the record as it stood at that moment; the job itself also stops writing once its record no
 * longer names it.
 *
 * Scenario: REAL idle node processes stand in for sampler children (claimed through the real job-record
 * transitions, killed through the same probe-then-SIGTERM `retire` the supervisor uses). After each
 * replacement exactly one live record may remain, carrying the new input, and the old process must be gone.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const DAEMON = 'scripts/conveyor/resource-sampler-daemon.mjs';
const IDLE_CHILD = "process.once('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);";
const OLD_SHA = 'b'.repeat(40);
const NEW_SHA = 'a'.repeat(40);
const AT = '2026-10-10T12:00:00.000Z';

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitGone = async (pid, ms = 3000) => {
  for (let waited = 0; waited < ms && alive(pid); waited += 50) await new Promise((done) => setTimeout(done, 50));
  return !alive(pid);
};

export default {
  id: 'resource-sampler-two-writers-and-stale-config',
  title: 'a replaced resource sampler stayed alive as a second snapshot writer, and a restart with changed config kept the old config',
  card: 'we:backlog/5713 (resource sampler slice 1; PR #4722 red-team round)',
  // sha list is reverse-applied newest first
  fixedBy: { sha: '320a78da7,f84969979', where: 'lane/resource-usage-service', paths: [`${DAEMON}`, 'scripts/conveyor/resource-sampler-job.mjs'] },
  fixPresent(root) {
    const p = join(root, DAEMON);
    return existsSync(p) && /sampler config changed/.test(readFileSync(p, 'utf8'));
  },
  async run({ log } = {}) {
    const daemon = await import(`${join(REPO_ROOT, DAEMON)}`);
    const runtime = await import(`${join(REPO_ROOT, 'scripts/lib/daemon-jobs-runtime.mjs')}`);
    const jobs = await import(`${join(REPO_ROOT, 'scripts/lib/daemon-jobs.mjs')}`);
    const { formatJobHandle, parseJobHandle, TERMINAL_JOB_STATUSES } = await import(`${join(REPO_ROOT, 'scripts/operations/job-record.mjs')}`);
    const dir = mkdtempSync(join(tmpdir(), 'soak-sampler-'));
    const children = [];
    const violations = [];
    // Same shape as the supervisor's `retire` (resource-sampler-daemon.mjs): probe the handle, SIGTERM its pid.
    const retire = (record) => {
      const handle = record.job.handle;
      if (handle && runtime.probeHandle(handle) === 'alive') {
        try { process.kill(parseJobHandle(handle).pid, 'SIGTERM'); } catch { /* already gone */ }
      }
    };
    const spawnClaimed = (store, id) => {
      const child = spawn(process.execPath, ['-e', IDLE_CHILD], { stdio: 'ignore' });
      children.push(child);
      const procStart = runtime.readProcStart(child.pid);
      const identity = { host: runtime.hostName(), pid: child.pid, procStart };
      return { child, claim: () => store.update(id, (r) => jobs.markClaimed(r, { at: AT, ...identity, handle: formatJobHandle(identity) })) };
    };
    const liveRecords = (store) => store.list().records.filter((r) => !TERMINAL_JOB_STATUSES.includes(r.job.status));
    const expectOneReplacement = async (label, store, oldChild, input) => {
      const live = liveRecords(store);
      if (live.length !== 1) violations.push({ invariant: 'one-live-record', detail: `${label}: ${live.length} live sampler records` });
      else if (JSON.stringify(live[0].input) !== JSON.stringify(input)) violations.push({ invariant: 'new-config-applied', detail: `${label}: live record kept ${JSON.stringify(live[0].input)}, wanted ${JSON.stringify(input)}` });
      if (!(await waitGone(oldChild.pid))) violations.push({ invariant: 'exactly-one-writer', detail: `${label}: replaced sampler pid ${oldChild.pid} is still alive` });
    };
    try {
      // Round 1 — restart with a changed interval on the SAME sha.
      mkdirSync(join(dir, 'config')); mkdirSync(join(dir, 'race'));
      const store1 = runtime.createJobStore(join(dir, 'config'));
      const first = daemon.ensureSamplerJob({ store: store1, codeSha: NEW_SHA, input: { intervalMs: 10000, root: '/tmp/c' }, retire });
      const c1 = spawnClaimed(store1, first.record.id);
      store1.update(first.record.id, (r) => jobs.markLaunching(r, { at: AT }));
      c1.claim();
      const changed = { intervalMs: 2500, root: '/tmp/c' };
      daemon.ensureSamplerJob({ store: store1, codeSha: NEW_SHA, input: changed, retire });
      await expectOneReplacement('config-change', store1, c1.child, changed);

      // Round 2 — the child claims AFTER ensure listed the record, BEFORE it replaced it.
      const store2 = runtime.createJobStore(join(dir, 'race'));
      const old = daemon.ensureSamplerJob({ store: store2, codeSha: OLD_SHA, input: { intervalMs: 10000 }, retire });
      store2.update(old.record.id, (r) => jobs.markLaunching(r, { at: AT }));
      const c2 = spawnClaimed(store2, old.record.id);
      const stale = store2.read(old.record.id);
      const racing = { ...store2, list: () => { const out = store2.list(); c2.claim(); return { ...out, records: [stale] }; } };
      const wanted = { intervalMs: 10000 };
      daemon.ensureSamplerJob({ store: racing, codeSha: NEW_SHA, input: wanted, retire });
      await expectOneReplacement('claim-race', store2, c2.child, wanted);
      log?.(`violations=${violations.length}`);
      return { violations };
    } finally {
      for (const child of children) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      rmSync(dir, { recursive: true, force: true });
    }
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
