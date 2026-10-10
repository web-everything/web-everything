#!/usr/bin/env node
/** Card xkuflno — supervisor only. Detached sampler jobs survive this process's restart. */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withFileLock } from '../lib/atomic-json-file.mjs';
import { createJobStore, enqueueJob, probeHandle, reattachTick, startJobLoop } from '../lib/daemon-jobs-runtime.mjs';
import { parseJobHandle } from '../operations/job-record.mjs';
import { defineJobKind, kindRegistry, markFailed } from '../lib/daemon-jobs.mjs';
import { TERMINAL_JOB_STATUSES } from '../operations/job-record.mjs';
import { daemonJobsDir } from '../operations/run-store.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';

export const RESOURCE_SAMPLE_KIND = defineJobKind({ kind: 'resource-sample',
  entry: 'scripts/conveyor/resource-sampler-job.mjs', codeMode: 'readonly-tree', maxAttempts: 1000 });

/** Key-order-independent JSON, so the same config compares equal however its object was built. */
const canonical = value => JSON.stringify(value, (_key, v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v));

const configKey = ({ checkoutRoot: _where, ...config } = {}) => canonical(config);

/** Caller serializes this read/enqueue transaction. Never infer absence from unreadable records. */
/**
 * The sampler job never finishes, so a job pinned to older code OR older config would sample that way forever
 * (live 2026-10-09: a lane-count fix never reached the running sampler — the dead job was requeued on its old
 * sha; and a restart with a new `--interval-ms`/`--root` silently kept the old input).
 * Exactly one live job may exist, and it must match BOTH `codeSha` and `input`. Every other live job is retired:
 * the record is marked failed FIRST (so a child that has not claimed yet is refused its claim), and only then is
 * `retire` called with the record as it stood at that moment — including a handle the child claimed after
 * `store.list()` read it — so the supervisor's SIGTERM-by-handle reaches the process that really exists.
 */
export function ensureSamplerJob({ store, kindDef = RESOURCE_SAMPLE_KIND, codeSha, now = Date.now(), input = {}, retire = () => {} }) {
  const { records, corrupt } = store.list();
  if (corrupt.length) throw new Error(`resource-sampler: corrupt job records: ${corrupt.join(', ')}`);
  const ofKind = records.filter(r => r.job.kind === kindDef.kind);
  const liveJobs = ofKind.filter(r => !TERMINAL_JOB_STATUSES.includes(r.job.status));
  // checkoutRoot is where this supervisor happens to live, not sampler config: the job runs the sha-pinned
  // snapshot either way, so two checkouts at one sha must not retire each other's job every tick.
  const wanted = configKey(input);
  const current = liveJobs.find(r => r.job.codeSha === codeSha && configKey(r.input) === wanted);
  // A failed record keeps `retiredHandle` until its process is confirmed retired, so a retire that threw (or a
  // supervisor killed between the fail and the signal) is retried on the next call instead of orphaning a writer.
  let retireError = null;
  const retireOnce = (record, handle) => {
    try {
      retire(handle === record.job.handle ? record : { ...record, job: { ...record.job, handle } });
      store.update(record.id, r => (r.job.retiredHandle ? { ...r, job: { ...r.job, retiredHandle: null } } : null));
    } catch (error) { retireError ??= error; }
  };
  for (const failed of ofKind) if (failed.job.retiredHandle && TERMINAL_JOB_STATUSES.includes(failed.job.status)) retireOnce(failed, failed.job.retiredHandle);
  for (const old of liveJobs) {
    if (old === current) continue;
    const reason = old.job.codeSha !== codeSha ? `superseded by ${String(codeSha).slice(0, 9)}`
      : current ? 'superseded: duplicate live sampler' : 'superseded: sampler config changed';
    let atRetirement = null;
    store.update(old.id, r => {
      if (TERMINAL_JOB_STATUSES.includes(r.job.status)) return null;
      atRetirement = r;
      const failed = markFailed(r, { at: new Date(now).toISOString(), reason });
      return r.job.handle ? { ...failed, job: { ...failed.job, retiredHandle: r.job.handle } } : failed;
    });
    if (atRetirement) retireOnce({ ...atRetirement, job: { ...atRetirement.job, retiredHandle: atRetirement.job.handle } }, atRetirement.job.handle);
  }
  if (retireError) throw retireError;
  if (current) return { enqueued: false, record: current };
  const base = `resource-sample-${new Date(now).toISOString().replace(/[:.]/g, '-')}`;
  let id = base; let suffix = 0;
  while (store.read(id)) id = `${base}-${++suffix}`;
  return { enqueued: true, record: enqueueJob({ store, kindDef, id, codeSha, now, input }) };
}

export async function main(argv = process.argv.slice(2)) {
  let intervalMs = 10000; let root; let once = false;
  for (const arg of argv) {
    if (arg === '--once') once = true;
    else if (arg.startsWith('--interval-ms=')) intervalMs = Number(arg.slice('--interval-ms='.length));
    else if (arg.startsWith('--root=') && arg.slice(7).trim()) root = resolve(arg.slice(7));
    else throw new Error(`resource-sampler: unknown or empty flag ${arg}`);
  }
  if (!Number.isInteger(intervalMs) || intervalMs <= 0 || intervalMs > 2147483647) throw new Error('--interval-ms must be a positive timer interval');
  const repoDir = fileURLToPath(new URL('../../', import.meta.url));
  const codeSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 }).trim();
  // A proof root isolates both snapshots and job records; normal boot uses the runtime's shared jobs home.
  const dir = root ? daemonJobsDir('resource-sampler', { WE_DAEMON_JOBS_ROOT: join(root, 'daemon-jobs') }) : daemonJobsDir('resource-sampler');
  mkdirSync(dir, { recursive: true });
  const store = createJobStore(dir);
  const log = message => console.log(`${new Date().toISOString()} resource-sampler ${message}`);
  const ensure = () => withFileLock(join(dir, 'ensure-sampler.lock'), () => {
    const retire = (record) => {
      const handle = record.job.handle;
      if (handle && probeHandle(handle) === 'alive') {
        try { process.kill(parseJobHandle(handle).pid, 'SIGTERM'); } catch { /* already gone */ }
      }
      log(`tick action ${JSON.stringify({ action: 'retire', id: record.id, codeSha: record.job.codeSha, for: codeSha })}`);
    };
    const result = ensureSamplerJob({ store, codeSha, retire, input: { intervalMs, root: root ?? resolveCoordinationRoot(), checkoutRoot: repoDir.replace(/\/$/, '') } });
    if (result.enqueued) log(`tick action ${JSON.stringify({ action: 'enqueue', id: result.record.id })}`);
    return result;
  });
  const onTick = result => {
    for (const action of result.actions) log(`tick action ${JSON.stringify(action)}`);
    ensure();
  };
  const options = { store, kinds: kindRegistry([RESOURCE_SAMPLE_KIND]), maxConcurrent: 1,
    snapshot: { repoDir }, log };
  ensure();
  if (once) { onTick(await reattachTick(options)); return; }
  const stop = startJobLoop({ ...options, intervalMs: 15000, onTick,
    onError: error => log(`tick error ${error?.stack ?? error}`) });
  process.once('SIGTERM', () => { stop(); log('SIGTERM — stopped supervisor; jobs keep running'); });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error?.stack ?? error); process.exitCode = 1; });
}
