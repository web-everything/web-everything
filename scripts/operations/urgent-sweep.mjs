/** Single bounded pass over urgent loads; unreadable evidence requires operator attention. */
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPlatformPreferences, resolveCascade } from '../lib/policy-cascade.mjs';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { readOverlayState } from '../lib/daemon-overlays.mjs';
import { retireRegistration, recoverDrops } from '../daemon-overlay.mjs';
import { resolveOriginRepository } from './prototype-retire.mjs';
import { safeRegistrationRef, validSha, TEST_CHECK_APP_ID, testCheckEvidence, testWorkflowBound } from './prototype-load.mjs';
import { ciGatePlan, urgentLedger, normalizeUrgentRepo } from './urgent-verify-marker.mjs';
import { writeEscalationPacket } from './land-advance-escalations.mjs';

const failedCheck = (c, sha) => c?.head_sha === sha && c.status === 'completed'
  && ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure'].includes(c.conclusion);
const identity = r => createHash('sha256').update(JSON.stringify([r.ref, r.sha, r.clone, r.registration, r.trackingId])).digest('hex');
const validateChecks = (data, sha) => {
  if (!Number.isInteger(data?.total_count)
    || data.total_count < 0 || data.total_count > 100 || !Array.isArray(data.check_runs)
    || data.check_runs.length !== data.total_count || new Set(data.check_runs.map(c => c?.id)).size !== data.total_count
    || data.check_runs.some(c => !Number.isSafeInteger(c?.id)
      || c.head_sha !== sha || typeof c.name !== 'string' || !Number.isSafeInteger(c.app?.id)
      || !['queued', 'in_progress', 'completed'].includes(c.status)
      || (c.status === 'completed' ? typeof c.conclusion !== 'string' : c.conclusion !== null)))
    throw new Error('unreadable, incomplete or oversized CI checks (maximum 100); repair reader or inspect CI manually');
};
export function createSweepDeps({ home = homedir(), io = fs, exec = execFileSync, ghExec = execFileSyncThrottled, retire = retireRegistration, recover = recoverDrops, readState = readOverlayState, env = process.env } = {}) {
  const read = name => {
    const path = urgentLedger(home, name);
    try {
      if (io.statSync(path).size > 4 * 1024 * 1024) throw new Error('ledger exceeds 4 MiB; archive settled records and retry');
      return io.readFileSync(path, 'utf8').split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l));
    } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  };
  const append = (name, record) => {
    const path = urgentLedger(home, name);
    io.mkdirSync(dirname(path), { recursive: true });
    io.appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  };
  return {
    loads: () => read('urgent-loads'), state: () => read('urgent-sweep-state'), now: () => new Date().toISOString(),
    required: r => ciGatePlan(String(exec('git', ['show', `${r.sha}:.github/workflows/ci.yml`],
      { cwd: r.clone, env, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 }))).requiredJobs,
    checks: r => {
      const git = args => ({ code: 0, stdout: String(exec('git', args, { cwd: r.clone, env, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 })) });
      if (normalizeUrgentRepo(git(['remote', 'get-url', 'origin']).stdout) !== r.repo) throw new Error('clone origin changed');
      const gh = args => ({ code: 0, stdout: String(ghExec('gh', args,
        { cwd: r.clone, env, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, throttle: { caller: 'urgent-sweep', exec: (a, o) => exec('gh', a, o) } })) });
      const origin = resolveOriginRepository({ git, gh });
      if (!origin.repo) throw new Error('unreadable CI repository');
      const result = origin.gh(['api', `repos/${origin.repo}/commits/${r.sha}/check-runs?per_page=100&filter=all`]);
      if (result.code !== 0) throw new Error('unreadable CI checks');
      const data = JSON.parse(result.stdout);
      if (Array.isArray(data?.check_runs) && data.check_runs.some(c => failedCheck(c, r.sha))) return data;
      // Preserve raw failures even when workflow/config evidence is unavailable.
      try {
        const tool = JSON.parse(io.readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../settings/prototype-load.json'), 'utf8'));
        const platform = readPlatformPreferences({ env: { ...env, HOME: home }, readFile: (p, encoding) => io.readFileSync(p, encoding) });
        if (platform.errors.length) throw new Error('unreadable prototype-load settings');
        const config = resolveCascade({ platform: platform.prefs.prototypeLoad, tool }).value;
        const runs = origin.gh(['api', `repos/${origin.repo}/actions/runs?head_sha=${r.sha}&per_page=100`]);
        return { ...data, workflows: runs.code === 0 ? JSON.parse(runs.stdout) : null, testWorkflowPath: config.testWorkflowPath };
      } catch { return { ...data, workflows: null }; }
    },
    overlayState: r => readState(r.clone, { env }),
    containsOverlay: r => {
      try {
        exec('git', ['merge-base', '--is-ancestor', r.sha, 'HEAD'],
          { cwd: r.clone, env, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
        return true;
      } catch (e) {
        if (e.status === 1) return false;
        throw new Error('unreadable clone HEAD ancestry; inspect the daemon build manually');
      }
    },
    mergedOverlay: r => {
      const options = { cwd: r.clone, env, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 };
      try {
        exec('git', ['fetch', '--quiet', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'], options);
      } catch { throw new Error('unreadable origin/main fetch; inspect overlay graduation manually'); }
      try {
        exec('git', ['merge-base', '--is-ancestor', r.sha, 'origin/main'], options);
        return true;
      } catch (e) {
        if (e.status === 1) return false;
        throw new Error('unreadable origin/main ancestry; inspect overlay graduation manually');
      }
    },
    remove: async (r, expectedEntry) => {
      const recovery = await recover({ root: r.clone, by: 'urgent-sweep', env });
      if (!Array.isArray(recovery?.pending) || recovery.pending.length) throw new Error('unsettled overlay drops; run recover-drops for the clone before retrying');
      return retire({ root: r.clone, ref: r.registration.ref, expectedTip: r.registration.sha,
        expectedEntry, mode: 'urgent-failed', trackingId: r.trackingId, by: 'urgent-sweep', env,
        deps: { readUrgentLoads: () => read('urgent-loads'), readUrgentDecisions: () => read('urgent-sweep-state') } });
    },
    event: r => append('urgent-loads', r), settle: r => append('urgent-sweep-state', r),
    escalate: packet => writeEscalationPacket(packet, { dir: join(home, 'workspace/.operations/escalations'), fs: io }),
  };
}

export async function urgentSweep(_input = {}, deps = createSweepDeps()) {
  const results = [], fallback = 'NEEDS-YOU: inspect urgent-loads and CI, repair unreadable evidence or unload the recorded overlay manually, then rerun urgent-sweep.';
  const escalate = (id, target, detail) => deps.escalate({ id: `urgent-${id}`, kind: 'needs-you', target,
    createdAt: deps.now(), status: 'open', evidence: [detail], question: fallback, ladder: { next: 'L3 operator' } });
  const notificationsComplete = r => r.status === 'settled-unloaded'
    || (r.unloadEventSent === true && r.unloadEscalationSent === true);
  const notifyUnload = async (id, r, receipt, errors) => {
    // Legacy settlements followed both notifications. New receipts checkpoint each sink separately.
    if (notificationsComplete(receipt)) return { ...receipt, unloadEventSent: true, unloadEscalationSent: true };
    for (const [flag, send] of [
      ['unloadEventSent', () => deps.event({ type: 'prototype-load.urgent-unloaded', at: receipt.removedAt ?? receipt.at,
        id, ref: r.ref, sha: r.sha, clone: r.clone, registration: r.registration })],
      ['unloadEscalationSent', () => escalate(id, r.ref, receipt.unloadReason ?? `Unloaded ${r.sha}: CI failed. Inspect and repair before reloading.`)],
    ]) {
      if (receipt[flag] === true) continue;
      try {
        await send();
        const next = { ...receipt, [flag]: true };
        await deps.settle(next);
        receipt = next;
      } catch (e) { errors.push(`${flag}: ${e.message}`); }
    }
    return receipt;
  };
  try {
    const settlements = deps.state();
    if (settlements.some(r => !/^[a-f0-9]{64}$/.test(r?.id ?? '') || !['unload-decision', 'monitoring-ci', 'monitoring-unregistered', 'monitoring-green', 'settled-green', 'settled-unloaded', 'unloaded-pending-adoption', 'unloaded-adopted', 'settled-unregistered', 'sweep-cursor'].includes(r.status)))
      throw new Error('unreadable urgent settlement ledger; repair it before sweeping');
    // Historical time-based green receipts never prove an overlay is no longer registered.
    // Old unload receipts prove removal only; resume them through the adoption check too.
    const unloaded = new Map(settlements.filter(r => ['settled-unloaded', 'unloaded-pending-adoption', 'unloaded-adopted'].includes(r.status)).map(r => [r.id, r]));
    const settled = new Set(settlements.filter(r => r.status === 'settled-unregistered' && r.ancestryVerified === true).map(r => r.id));
    const absent = new Map(settlements.filter(r => r.status === 'monitoring-unregistered').map(r => [r.id, r]));
    for (const [id, r] of unloaded) if (r.status === 'unloaded-adopted' && notificationsComplete(r)) settled.add(id);
    const ciEscalated = new Set(settlements.filter(r => r.status === 'monitoring-ci' && r.noVerdictEscalated === true).map(r => r.id));
    const green = new Map(settlements.filter(r => r.status === 'monitoring-green').map(r => [r.id, r.greenAt]));
    const records = deps.loads();
    const failed = new Set(records.filter(r => r.type === 'prototype-load.urgent-registration-failed'
      && typeof r.trackingId === 'string').map(r => r.trackingId));
    const loads = new Map(records.filter(r => r.type === 'prototype-load.urgent').map(r => [identity(r), r]));
    const entries = [...loads], cursor = settlements.filter(r => r.status === 'sweep-cursor').at(-1)?.id;
    // Use the complete load order so even a cursor load settled last pass remains an anchor.
    // Older ledgers (or an archived cursor load) start at the beginning.
    const start = entries.findIndex(([id]) => id === cursor) + 1;
    const batch = [...entries.slice(start), ...entries.slice(0, start)].filter(([id]) => !settled.has(id)).slice(0, 32);
    // Persist before readers/escalations: an unreadable or pending batch must not monopolize later ticks.
    if (batch.length) await deps.settle({ id: batch.at(-1)[0], status: 'sweep-cursor', at: deps.now() });
    // Three GitHub reads per load, at most 96 per tick. Remaining entries wait for the next orchestrator tick.
    for (const [id, r] of batch) {
      const notificationErrors = [];
      const report = result => results.push(notificationErrors.length
        ? { id, status: 'needs-you', detail: `Unload notifications incomplete; retry next sweep: ${notificationErrors.join('; ')}` } : result);
      try {
        if (!validSha(r.sha) || !safeRegistrationRef(r.ref) || !isAbsolute(r.clone ?? '')
          || r.registration?.clone !== r.clone || !safeRegistrationRef(r.registration?.ref) || !validSha(r.registration?.sha))
          throw new Error('legacy or incomplete urgent registration; recover clone and ref manually');
        let pending = unloaded.get(id);
        if (pending) {
          pending = await notifyUnload(id, r, pending, notificationErrors);
          if (pending.status === 'unloaded-adopted') {
            report({ id, status: 'unloaded-adopted' });
            continue;
          }
        }
        const overlay = await deps.overlayState(r);
        if (!overlay || overlay.corrupt !== false || !Array.isArray(overlay.overlays)
          || overlay.overlays.some(e => !safeRegistrationRef(e?.ref)))
          throw new Error('unreadable overlay state; repair store or inspect registration manually');
        const registered = overlay.overlays.some(e => e.ref === r.registration.ref);
        // A failed command may have persisted its overlay before failing to append its event.
        if (failed.has(r.trackingId) && !registered && !pending) continue;
        if (pending) {
          const removedAt = pending.removedAt ?? pending.at, now = Date.parse(deps.now());
          if (!Number.isFinite(Date.parse(removedAt)) || !Number.isFinite(now) || now < Date.parse(removedAt))
            throw new Error('unreadable unload timestamp; inspect the daemon build manually');
          const contains = await deps.containsOverlay(r);
          if (typeof contains !== 'boolean') throw new Error('unreadable clone HEAD ancestry; inspect the daemon build manually');
          if (!registered && !contains) {
            await deps.settle({ ...pending, removedAt, at: deps.now(), status: 'unloaded-adopted' });
            report({ id, status: 'unloaded-adopted' });
          } else if (!registered && contains && now - Date.parse(removedAt) >= 15 * 60 * 1000) {
            const detail = `The daemon fell back to a last-good build containing the failed overlay ${r.sha} after registration removal. Inspect and repair the daemon build in ${r.clone}.`;
            if (!pending.fallbackEscalated) {
              await escalate(`${id}-fallback`, r.ref, detail);
              await deps.settle({ ...pending, removedAt, status: 'unloaded-pending-adoption', fallbackEscalated: true });
            }
            report({ id, status: 'needs-you', detail });
          } else report({ id, status: 'unloaded-pending-adoption' });
          continue;
        }
        if (!registered) {
          const contains = await deps.containsOverlay(r);
          if (typeof contains !== 'boolean') throw new Error('unreadable clone HEAD ancestry; inspect the daemon build manually');
          const merged = contains ? await deps.mergedOverlay(r) : false;
          if (typeof merged !== 'boolean') throw new Error('unreadable origin/main ancestry; inspect overlay graduation manually');
          if (!contains || merged) {
            await deps.settle({ id, ref: r.ref, sha: r.sha, at: deps.now(), status: 'settled-unregistered', ancestryVerified: true });
            results.push({ id, status: 'settled-unregistered' });
            continue;
          }
          let receipt = absent.get(id) ?? { id, ref: r.ref, sha: r.sha, at: deps.now(), status: 'monitoring-unregistered' };
          const now = Date.parse(deps.now()), absentAt = Date.parse(receipt.at);
          if (!Number.isFinite(now) || !Number.isFinite(absentAt) || now < absentAt)
            throw new Error('unreadable absent registration timestamp; inspect the daemon build manually');
          if (!absent.has(id)) await deps.settle(receipt);
          // Removal is already a no-op. Continue reading CI and escalate the live build directly.
          const data = await deps.checks(r);
          const failed = Array.isArray(data?.check_runs) && data.check_runs.some(c => failedCheck(c, r.sha));
          if (!failed) validateChecks(data, r.sha);
          const overdue = now - absentAt >= 15 * 60 * 1000;
          const detail = `The daemon still runs a build containing unmerged urgent overlay ${r.sha} after registration removal${failed ? '; CI failed and unloading is a no-op' : ''}. Inspect and repair the daemon build in ${r.clone}.`;
          if (failed || overdue) {
            if (!receipt.fallbackEscalated) {
              await escalate(`${id}-fallback`, r.ref, detail);
              receipt = { ...receipt, fallbackEscalated: true };
              await deps.settle(receipt);
            }
            results.push({ id, status: 'needs-you', detail });
          } else results.push({ id, status: receipt.status });
          continue;
        }
        const loadedAt = Date.parse(r.at), now = Date.parse(deps.now());
        if (!Number.isFinite(loadedAt) || !Number.isFinite(now) || now < loadedAt)
          throw new Error('unreadable urgent load timestamp; inspect CI or unload manually');
        const age = now - loadedAt;
        let data, unload = false, requiredSucceeded = false, unloadReason, evidenceError;
        try {
          data = await deps.checks(r);
          unload = Array.isArray(data?.check_runs) && data.check_runs.some(c => failedCheck(c, r.sha));
          if (!unload) {
            validateChecks(data, r.sha);
            const required = await deps.required(r);
            if (!Array.isArray(required) || !required.includes('test')) throw new Error('unreadable required CI jobs');
            const checks = data.check_runs.filter(c => c.app.id === TEST_CHECK_APP_ID
              && required.some(n => c.name === n || c.name.startsWith(`${n} (`)));
            requiredSucceeded = testWorkflowBound(testCheckEvidence(data, r.sha), data.workflows, r.sha, data.testWorkflowPath)
              && required.every(n => checks.some(c => c.name === n || c.name.startsWith(`${n} (`)))
              && checks.every(c => c.status === 'completed' && c.conclusion === 'success');
          }
        } catch (e) { evidenceError = e; }
        if (!unload && !requiredSucceeded && !green.has(id)) {
          if (age >= 6 * 60 * 60 * 1000 && !ciEscalated.has(id)) {
            await escalate(`${id}-no-ci-verdict`, r.ref, 'urgent load has no CI verdict after 6h');
            await deps.settle({ id, ref: r.ref, sha: r.sha, at: deps.now(), status: 'monitoring-ci', noVerdictEscalated: true });
            ciEscalated.add(id);
          }
          unload = age >= 24 * 60 * 60 * 1000;
          if (unload) unloadReason = `Unloaded ${r.sha}: urgent load has no CI verdict after 24h. Inspect and repair before reloading.`;
        }
        if (evidenceError && !unload) {
          if (age < 6 * 60 * 60 * 1000 || green.has(id)) throw evidenceError;
          results.push({ id, status: 'needs-you', detail: String(evidenceError.message) });
          continue;
        }
        if (unload) {
          // Commit negative evidence before the guarded mutation; a write failure keeps the overlay.
          const failed = Array.isArray(data?.check_runs) ? data.check_runs.find(c => failedCheck(c, r.sha)) : undefined;
          await deps.settle({ id, status: 'unload-decision', at: deps.now(), trackingId: r.trackingId,
            clone: r.clone, ref: r.ref, sha: r.sha, registration: r.registration,
            reason: unloadReason ? 'ci-expired' : 'ci-failed',
            ...(unloadReason ? {} : { check: { head_sha: failed.head_sha, status: failed.status, conclusion: failed.conclusion } }) });
          const removal = await deps.remove(r, overlay.overlays.find(e => e.ref === r.registration.ref));
          if (!removal || removal.refused || (removal.retired !== true && (!Array.isArray(removal.list) || removal.list.some(e => e.ref === r.registration.ref)))) throw new Error(`overlay removal refused: ${removal?.refused ?? 'unreadable result'}`);
          const event = { type: 'prototype-load.urgent-unloaded', at: deps.now(), id, ref: r.ref, sha: r.sha, clone: r.clone, registration: r.registration };
          const receipt = { ...event, ...(unloadReason ? { unloadReason } : {}), removedAt: event.at, status: 'unloaded-pending-adoption', unloadEventSent: false, unloadEscalationSent: false };
          await deps.settle(receipt);
          await notifyUnload(id, r, receipt, notificationErrors);
          report({ id, status: 'unloaded-pending-adoption' });
        } else {
          if (requiredSucceeded && data.check_runs.every(c => c.status === 'completed')) {
            const at = deps.now(), greenAt = green.get(id) ?? at;
            if (!Number.isFinite(Date.parse(at)) || !Number.isFinite(Date.parse(greenAt))) throw new Error('unreadable green monitoring timestamp');
            const status = 'monitoring-green';
            if (!green.has(id)) await deps.settle({ id, ref: r.ref, sha: r.sha, at, greenAt, status, checksComplete: true });
            results.push({ id, status });
          } else results.push({ id, status: 'pending' });
        }
      } catch (e) {
        await escalate(id, r.ref, String(e.message));
        results.push({ id, status: 'needs-you', detail: String(e.message) });
      }
    }
    return { ok: results.every(r => r.status !== 'needs-you'), results, fallback };
  } catch (e) {
    await escalate('ledger', 'urgent-sweep', String(e.message));
    return { ok: false, detail: String(e.message), fallback };
  }
}
