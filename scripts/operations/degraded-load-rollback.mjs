/** Refused R1075 candidates never need a forced-build rollback: withdraw through guarded retirement. */
import fs from 'node:fs';
import { retireRegistration, proveOverlayWithdrawal } from '../daemon-overlay.mjs';
import { readOverlayState } from '../lib/daemon-overlays.mjs';
import { reportNeedsYou } from '../lib/daemon-rebuild/auto-rebase.mjs';
import { appendDaemonEvent } from '../lib/daemon-events.mjs';
import { readPendingAdoptions, clearPendingAdoption } from '../lib/overlay-adoption.mjs';

export async function rollbackDegradedLoad({ root, ref, sha, fastPath, reason, env,
  readState = readOverlayState, retire = retireRegistration, needsYou = reportNeedsYou,
  emit = appendDaemonEvent, io = fs, now = () => Date.now(), git, tip }) {
  let rollback;
  try {
    const state = await readState(root, { env });
    if (state?.corrupt !== false || !Array.isArray(state.overlays)) throw new Error('unreadable registry');
    const entry = state.overlays.find(r => r.ref === ref);
    rollback = entry ? await retire({ root, ref, expectedTip: sha, expectedEntry: entry, by: 'prototype-load.degraded-fast-path', env,
      deps: { prove: () => proveOverlayWithdrawal({ root, ref, tip: sha, reason: 'degraded-fast-path-refused', env, ...(git ? { git } : {}) }),
        ...(tip ? { tip } : {}) } }) : { retired: true, absent: true };
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
