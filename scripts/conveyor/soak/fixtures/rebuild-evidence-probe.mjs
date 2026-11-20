/** Replay persisted writer output and legacy metadata through real rebuild admission. */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createJobStore, enqueueJob } from '../../../lib/daemon-jobs-runtime.mjs';
import { markSucceeded } from '../../../lib/daemon-jobs.mjs';
import { rebuildCloneAsJob, buildRebuildJobResult, REBUILD_JOB_KIND, RESULT_SUFFIX } from '../../../lib/daemon-rebuild/rebuild-job.mjs';
import { createRebuildReaders } from '../../../lib/daemon-rebuild/evidence-readers.mjs';
import { overlayFilePath, appendOverlayEvent } from '../../../lib/daemon-overlays.mjs';
import { writeRebuildState, readRebuildState } from '../../../lib/daemon-rebuild/state.mjs';
import { envTimeoutAppliesToPlan } from '../../../lib/daemon-rebuild/recovery.mjs';

export async function probeRebuildEvidence() {
  const root = mkdtempSync(join(tmpdir(), 'rebuild-evidence-soak-'));
  const env = { WE_DAEMON_STATE_DIR: join(root, 'state'), WE_DAEMON_OVERLAY_DIR: join(root, 'overlays') };
  try {
    const store = createJobStore(join(root, 'jobs'));
    mkdirSync(store.dir);
    const old = enqueueJob({ store, kindDef: REBUILD_JOB_KIND, codeSha: 'a'.repeat(40), input: { root }, now: 1000 });
    store.update(old.id, r => markSucceeded(r, { at: new Date(1000).toISOString() }));
    writeFileSync(join(store.dir, old.id + RESULT_SUFFIX), JSON.stringify(buildRebuildJobResult({}, {}, null, 1000)));
    const registry = overlayFilePath(root, env);
    mkdirSync(dirname(registry), { recursive: true });
    writeFileSync(registry, JSON.stringify({ overlays: [{ ref: 'lane/legacy' }] }));
    appendOverlayEvent(root, { kind: 'auto-rebase-swapped', old: 'lane/old', new: 'lane/new', newSha: 'b'.repeat(40) }, { env });
    const registryBefore = readFileSync(registry, 'utf8');
    const events = registry.replace(/\.json$/, '.events.jsonl');
    const eventsBefore = readFileSync(events, 'utf8');
    const held = { reason: 'smoke-env-timeout', since: new Date(1000).toISOString(), updatedAt: new Date(1000).toISOString(),
      inputsKey: 'old-inputs', target: 'a'.repeat(40), attempts: 3, retryAt: new Date(2_400_000).toISOString() };
    writeRebuildState(root, { held }, env);
    const readers = createRebuildReaders({ strict: true });
    readers.validate(root, env);
    const oldPlan = { inputsKey: held.inputsKey, finalSha: held.target };
    const changedPlan = { inputsKey: 'new-inputs', finalSha: 'b'.repeat(40) };
    // Admission uses the same identity policy as prepareRebuild; Git/planning IO
    // is represented by two main revisions. Unit coverage also reaches real prepare.
    let plan = oldPlan;
    const invoke = () => rebuildCloneAsJob({ root, env, store, launchOnly: true, launchedBy: 'early',
      now: () => 1001, codeSha: 'a'.repeat(40), settings: { minIntervalMs: 0, minIntervalJitterPct: 0 },
      adopt: async () => ({ reason: envTimeoutAppliesToPlan(readRebuildState(root, env).held, plan)
        ? 'smoke-env-timeout-backoff' : 'needs-build', plan }),
      reattach: async () => {}, evict() {}, log: { error() {} } });
    const before = await invoke();
    plan = changedPlan;
    const changed = await invoke();
    const again = await invoke();
    return { before: before.reason, consumedReason: before.finishedJobs?.[0]?.reason,
      changed: changed.reason, again: again.reason, jobs: store.list().records.length,
      preserved: readFileSync(registry, 'utf8') === registryBefore && readFileSync(events, 'utf8') === eventsBefore };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
