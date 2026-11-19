/** Hermetic recovery replay through the real durable rebuild job queue. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rebuildCloneAsJob } from '../../../lib/daemon-rebuild/rebuild-job.mjs';
import { writeRebuildState } from '../../../lib/daemon-rebuild/state.mjs';
import { recordPendingAdoption } from '../../../lib/overlay-adoption.mjs';
import { createJobStore } from '../../../lib/daemon-jobs-runtime.mjs';
import { envTimeoutRetry } from '../../../lib/daemon-rebuild/recovery.mjs';

export const recoverySettings = { envTimeoutBaseMs: 600_000, envTimeoutMaxMs: 2_400_000, overlayOverdueMs: 900_000 };
export async function probeRebuildRecovery({ timeout = false, legacy = false, corrupt = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rebuild-recovery-'));
  const env = { WE_DAEMON_STATE_DIR: join(root, 'state'), WE_DAEMON_OVERLAY_DIR: join(root, 'overlays') };
  const store = createJobStore(join(root, 'jobs'));
  let clock = 1_800_000;
  try {
    if (timeout) {
      const held = { reason: 'smoke-env-timeout', since: new Date(clock).toISOString(), updatedAt: new Date(clock).toISOString() };
      if (!legacy) Object.assign(held, envTimeoutRetry(null, clock, recoverySettings));
      writeRebuildState(root, { held }, env);
    } else {
      if (!recordPendingAdoption(root, { ref: 'lane/recovery', sha: 'a'.repeat(40), at: new Date(clock - 900_000).toISOString() }, { env })) throw new Error('registration failed');
    }
    const invoke = () => rebuildCloneAsJob({ root, env, store: corrupt ? { ...store, list: () => ({ records: [], corrupt: ['unreadable'] }) } : store,
      now: () => clock, recoverySettings, settings: { minIntervalMs: 0, minIntervalJitterPct: 0 },
      adopt: async () => ({ reason: timeout ? (clock < 2_400_000 ? 'smoke-env-timeout-backoff' : 'needs-build') : 'up-to-date' }),
      codeSha: 'b'.repeat(40), reattach: async () => {}, evict: () => {}, log: { error() {} } });
    const before = timeout ? await invoke() : null;
    if (timeout) clock += 600_000;
    const due = await invoke();
    const again = await invoke();
    return { before: before?.reason, due: due.reason, again: again.reason, jobs: store.list().records.length };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
