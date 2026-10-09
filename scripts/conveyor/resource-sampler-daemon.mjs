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

/** Caller serializes this read/enqueue transaction. Never infer absence from unreadable records. */
/**
 * The sampler job never finishes, so a job pinned to older code would sample with that code forever (live
 * 2026-10-09: a lane-count fix never reached the running sampler — the dead job was requeued on its old sha).
 * A live job on a different sha is therefore retired: `retire` stops its process (the supervisor passes a
 * SIGTERM-by-handle), the record is marked failed "superseded", and a fresh job is queued on `codeSha`.
 */
export function ensureSamplerJob({ store, kindDef = RESOURCE_SAMPLE_KIND, codeSha, now = Date.now(), input = {}, retire = () => {} }) {
  const { records, corrupt } = store.list();
  if (corrupt.length) throw new Error(`resource-sampler: corrupt job records: ${corrupt.join(', ')}`);
  const live = records.find(r => r.job.kind === kindDef.kind && !TERMINAL_JOB_STATUSES.includes(r.job.status));
  if (live && live.job.codeSha === codeSha) return { enqueued: false, record: live };
  if (live) {
    retire(live);
    store.update(live.id, r => markFailed(r, { at: new Date(now).toISOString(), reason: `superseded by ${String(codeSha).slice(0, 9)}` }));
  }
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
