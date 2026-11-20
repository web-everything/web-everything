/** Refused R1075 candidates never need a forced-build rollback: withdraw through guarded retirement. */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { retireRegistration, proveOverlayWithdrawal } from '../daemon-overlay.mjs';
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
      // Failed unmerged work is withdrawn, not declared merged. All other keep
      // decisions, pinned entries and approved edge resolutions remain protected.
      const plan = await planner({ rows: [entry], proofRows: state.overlays, git: gitArgs, gh: ghArgs });
      const mayWithdraw = (d, row) => d?.action === 'keep'
        && ['unique-commits-not-on-main', 'pr-open'].includes(d.reason) && !row.pinned && !row.edgeResolution;
      const select = (decisions, row) => Array.isArray(decisions) ? decisions.find(d => d?.ref === ref
        && d.tip === sha && /^[a-f0-9]{40}$/.test(sha ?? '')
        && (d.action === 'retire' || mayWithdraw(d, row))) : null;
      const decision = select(plan, entry);
      rollback = decision
        ? await retire({ root, ref, expectedTip: sha, expectedEntry: entry, by: 'prototype-load.degraded-fast-path', env,
          deps: {
            tip: tip ?? (r => {
              const current = gitArgs(['ls-remote', 'origin', `refs/heads/${r}`]);
              if (current.code !== 0) throw new Error('unreadable remote tip');
              return current.stdout.trim().split(/\s+/)[0];
            }),
            prove: prove ?? (current => {
              // Re-prove under retireRegistration's add guard, including uncached
              // stack ancestry. Its identity and pre/post-drop tip checks still apply.
              const registry = readOverlayState(root, { env });
              if (registry.corrupt) return { action: 'keep', reason: 'registry-unreadable' };
              const fresh = select(planner({ rows: [current], proofRows: registry.overlays, git: gitArgs, gh: ghArgs }), current);
              if (!fresh) return { action: 'keep', reason: 'retirement-unproved' };
              if (fresh.action === 'retire') return fresh;
              return proveOverlayWithdrawal({ root, ref, tip: sha, reason: 'degraded-smoke-failed', env,
                git: (...args) => gitArgs(args) });
            }),
          } })
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

/** Refusal evidence must name the registration, not merely mention its ref in prose. */
export function matchesDegradedRegistration(detail, { ref, sha }) {
  return (detail?.ref === ref || (Array.isArray(detail?.refs) && detail.refs.includes(ref)))
    && (detail.sha === undefined || detail.sha === sha);
}

/** Called by the rebuild that owns smoke, including after prototype-load has returned pending. */
export async function checkDegradedFailures({ root, result, env, now = () => Date.now(), ...deps }) {
  for (const pending of readPendingAdoptions(root, { env })) {
    if (!pending.degradedFastPath) continue;
    const refused = (result.alerts ?? []).find(a => /discard|reject|drop|refus|conflict/.test(a.kind)
      && !['expired', 'other-base', 'already-head'].includes(a.detail?.reason)
      && matchesDegradedRegistration(a.detail, pending));
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
