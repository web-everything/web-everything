/** fix-waiting: observe host refusals and confirmed launches; never decide admission. */
import { isSendBackFix } from './fix-waiting-priority.mjs';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveLimitStatePath } from '../lib/pr-limit.mjs';
import { writeJsonAtomic } from '../lib/atomic-json-file.mjs';
import { readSettings } from '../lib/settings-files.mjs';
import { cascadePolicy } from '../lib/policy-cascade.mjs';
import { createGhProvider } from '../lib/review-label-provider.mjs';
import { notifyDesktopChecked } from './branch-sync.mjs';

export const FIX_WAITING_LABEL = 'fix-waiting:host-busy';

/** Resolve the existing standard → platform → tool → env cascade, retaining provenance. */
export function resolveFixWaitingSettings({ env = process.env, file = readSettings(), platform } = {}) {
  const raw = env.WE_FIX_WAITING_HOST_BUSY_ALERT_MINUTES;
  const resolved = cascadePolicy('fixWaiting', file.fixWaiting, {
    env, platform, standard: { hostBusyAlertMinutes: 30 },
    envValues: { hostBusyAlertMinutes: raw === undefined || raw.trim() === '' ? undefined : Number(raw) },
    valid: { hostBusyAlertMinutes: value => Number.isFinite(value) && value >= 0 },
  });
  const source = resolved.sources.hostBusyAlertMinutes;
  return { value: resolved.value.hostBusyAlertMinutes, source: source === 'standard' ? 'default' : source };
}

/** Same state directory resolver as pr-limit; one file per repo avoids cross-repo lost updates. */
export function fixWaitingStatePath(repo, env = process.env) {
  return join(dirname(resolveLimitStatePath(env)), `fix-waiting-${repo.replace(/[^a-z0-9-]/gi, '_')}.json`);
}

/**
 * Per-pass observer. Snapshots win over remembered label state; missing snapshots reuse the last successful write.
 * Every IO failure is visible and best-effort: an observability failure must never alter a guard or launch result.
 * Dry runs only read the store and report proposed operations, including overdue episode alerts.
 */
export function createFixWaitingObserver({ repo, path = fixWaitingStatePath(repo), provider = createGhProvider(),
  notify = notifyDesktopChecked, setting = resolveFixWaitingSettings(), now = Date.now(), dryRun = false,
  log = line => console.error(line),
} = {}) {
  log(`reconcile-fix-dispatch: fix-waiting alert limit ${setting.value} min (source: ${setting.source})`);
  let state = {};
  let readable = true;
  try {
    state = JSON.parse(readFileSync(path, 'utf8'));
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('invalid waiting state');
  } catch (error) {
    state = {};
    if (error.code !== 'ENOENT') { readable = false; log(`reconcile-fix-dispatch: fix-waiting state unreadable: ${error.message}`); }
  }
  const save = () => {
    if (dryRun || !readable) return;
    mkdirSync(dirname(path), { recursive: true }); writeJsonAtomic(path, state);
  };
  const observe = (entry, waiting) => {
    try {
      const pr = entry.pr ?? entry.prNumber; const key = `${repo}#${pr}`;
      const previous = state[key];
      const labelled = Array.isArray(entry.labels)
        ? entry.labels.some(label => (typeof label === 'string' ? label : label?.name) === FIX_WAITING_LABEL)
        : previous?.labelled === true;
      let row = previous && !(waiting && previous.waiting === false)
        ? { ...previous } : { firstDeferredAt: now, labelled: previous?.labelled === true };
      if (waiting !== labelled) {
        const verb = waiting ? 'set' : 'clear';
        if (dryRun) log(`reconcile-fix-dispatch: would ${verb} ${FIX_WAITING_LABEL} on #${pr} (${repo})`);
        else {
          try {
            if (waiting) provider.ensureLabel(repo, FIX_WAITING_LABEL, {
              color: 'fbca04', description: 'Fix queued: waiting for host resources before a fixer can start (auto-managed)',
            });
            provider.setLabels(repo, pr, waiting ? { add: FIX_WAITING_LABEL, remove: [] } : { remove: [FIX_WAITING_LABEL] });
            row.labelled = waiting;
          } catch (error) { log(`reconcile-fix-dispatch: fix-waiting label ${verb} failed for #${pr}: ${error.message}`); }
        }
      } else row.labelled = labelled;
      const sendBack = entry.labels === undefined && !entry.operatorSendBack ? previous?.sendBack === true : isSendBackFix(entry);
      if (waiting) {
        row.waiting = true;
        row.updatedAt = now;
        row.sendBack = sendBack;
        if (readable && !row.alertedAt && now - row.firstDeferredAt > setting.value * 60000) {
          if (dryRun) log(`reconcile-fix-dispatch: would alert ${repo}#${pr}: ${FIX_WAITING_LABEL}, waiting over ${setting.value} min`);
          else {
            const result = notify({ title: 'Fix waiting: host busy', body: `${repo}#${pr} has waited over ${setting.value} min for host resources.` });
            if (result?.ok || result?.queued) row.alertedAt = now;
            else log(`reconcile-fix-dispatch: fix-waiting alert failed for #${pr}: ${result?.error ?? 'delivery failed'}`);
          }
        }
        state[key] = row;
      } else if (sendBack) {
        // Keep bounded identity evidence for this fixer's heavy commands after launch; never a launch blocker.
        state[key] = { ...row, waiting: false, sendBack: true, updatedAt: now };
      } else if (!row.labelled) delete state[key];
      // Avoid filesystem churn on unchanged episodes.
      if (JSON.stringify(previous) !== JSON.stringify(state[key])) save();
    } catch (error) { log(`reconcile-fix-dispatch: fix-waiting observation failed: ${error.message}`); }
  };
  return { deferred: entry => observe(entry, true), dispatched: entry => observe(entry, false) };
}
