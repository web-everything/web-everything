/** Refused R1075 candidates never need a forced-build rollback: withdraw through guarded retirement. */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { retireRegistration } from '../daemon-overlay.mjs';
import { defaultRetirePlanner } from './prototype-retire.mjs';

const run = (cmd, args, cwd, env) => {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  return { code: Number.isInteger(r.status) ? r.status : -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.stderr || r.error?.message || '' };
};
import { readOverlayState } from '../lib/daemon-overlays.mjs';
import { reportNeedsYou } from '../lib/daemon-rebuild/auto-rebase.mjs';
import { appendDaemonEvent } from '../lib/daemon-events.mjs';
import { readPendingAdoptions, clearPendingAdoption } from '../lib/overlay-adoption.mjs';

export async function rollbackDegradedLoad({ root, ref, sha, fastPath, reason, env,
  readState = readOverlayState, retire = retireRegistration, needsYou = reportNeedsYou,
  emit = appendDaemonEvent, io = fs, now = () => Date.now(), tip, prove, planner = defaultRetirePlanner,
  gitArgs = (args) => run('git', args, root, env), ghArgs = (args) => run('gh', args, root, env) }) {
  let rollback;
  try {
    const state = await readState(root, { env });
    if (state?.corrupt !== false || !Array.isArray(state.overlays)) throw new Error('unreadable registry');
    const entry = state.overlays.find(r => r.ref === ref);
    if (!entry) rollback = { retired: true, absent: true };
    else {
      // Same protections as the ordinary retirement planner (pinned closed PRs, edge resolution, merged/superseded proof).
      // Unproven retirement keeps the overlay: the load stays registered, is refused, and NEEDS-YOU is raised.
      const plan = await planner({ rows: [entry], proofRows: state.overlays, git: gitArgs, gh: ghArgs });
      const decision = Array.isArray(plan) ? plan.find(d => d?.ref === ref && d.action === 'retire' && /^[a-f0-9]{40}$/.test(d.tip ?? '')) : null;
      rollback = decision
        ? await retire({ root, ref, expectedTip: decision.tip, expectedEntry: entry, by: 'prototype-load.degraded-fast-path', env,
          deps: { ...(tip ? { tip } : {}), ...(prove ? { prove } : {}) } })
        : { retired: false, refused: 'retirement-unproved', kept: true };
    }
  } catch (e) { rollback = { retired: false, refused: String(e.message || e) }; }
  const detail = { ...fastPath, ref, reason, rollback };
  needsYou({ root, env, ref, stage: 'prototype-load.degraded-fast-path-failed',
    error: `NEEDS-YOU: ${reason}; registration ${rollback?.retired ? 'withdrawn' : 'withdrawal refused; inspect registry and unload manually'}`, io,
    now: () => new Date(now()).toISOString() });
  const eventRecorded = await emit({ kind: 'prototype-load.degraded-fast-path-failed', daemon: fastPath.daemon, detail },
    { env, now: () => new Date(now()) });
  return { ...rollback, eventRecorded: eventRecorded === true };
}

/** Called by the rebuild that owns smoke, including after prototype-load has returned pending. */
export async function checkDegradedFailures({ root, result, env, now = () => Date.now(), ...deps }) {
  for (const pending of readPendingAdoptions(root, { env })) {
    if (!pending.degradedFastPath) continue;
    const refused = (result.alerts ?? []).find(a => /discard|reject|drop|refus|conflict/.test(a.kind)
      && !['expired', 'other-base', 'already-head'].includes(a.detail?.reason)
      && JSON.stringify(a.detail ?? {}).includes(pending.ref));
    const smoked = /^(?:smoke-|dispatch-smoke-failed|still-rejected)/.test(result.reason ?? '')
      && result.plan?.applied?.some(a => a.ref === pending.ref && a.sha === pending.sha);
    const dropped = [...(result.fallback?.dropped ?? []), ...(result.setAside?.dropped ?? [])]
      .some(a => a.ref === pending.ref && (!a.sha || a.sha === pending.sha));
    if ((result.adopted || result.moved) && !dropped) continue;
    if (!refused && !smoked && !dropped) continue;
    const rollback = await rollbackDegradedLoad({ root, ref: pending.ref, sha: pending.sha,
      fastPath: pending.degradedFastPath, reason: refused?.kind ?? result.reason, env, now, ...deps });
    if (rollback?.retired && rollback.eventRecorded) clearPendingAdoption(root, pending, { env });
  }
}
