/** Overlay retirement uses verified Git evidence; uncertainty preserves registrations. */
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cascadePolicy, logCascadeSources } from './policy-cascade.mjs';
import {
  removeOverlay as removeDefault, appendOverlayEvent as auditDefault, persistTipShas as persistTipsDefault, registrationIdentity,
} from './daemon-overlays.mjs';
import { appendDaemonEvent as eventDefault } from './daemon-events.mjs';
import { isSafeBranchName } from './daemon-self-sync.mjs';
import { pinnedStatus } from './daemon-rebuild/plan.mjs';

const SETTINGS = join(dirname(fileURLToPath(import.meta.url)), 'daemon-rebuild-settings.json');
const SHA = /^[0-9a-f]{40,64}$/;
/** Standard → platform → tool → environment; shadow requires explicit promotion to on. */
export function resolveAutoRetireMode(env = process.env, { settingsPath = SETTINGS } = {}) {
  let tool;
  try { tool = JSON.parse(readFileSync(settingsPath, 'utf8')).autoRetire; } catch { /* unset */ }
  const r = cascadePolicy('autoRetire', tool, {
    env, standard: { mode: 'shadow' },
    envValues: { mode: env?.WE_DAEMON_OVERLAY_AUTO_RETIRE?.trim() || undefined },
    valid: { mode: (v) => ['off', 'shadow', 'on'].includes(v), shadowSince: (v) => typeof v === 'string' && Number.isFinite(Date.parse(v)) },
  });
  const mode = r.value.mode;
  const source = r.sources.mode;
  logCascadeSources('autoRetire.effective', { value: { mode }, sources: { mode: source } }, { env });
  return { mode, source, shadowSince: r.value.shadowSince };
}

/** Git runner takes argv and returns spawnSync-shaped results. No worktree or network mutations. */
export function classifyOverlays({ overlays, git, mainSha = 'origin/main', refEvidence, recordedShas }) {
  const call = (args, allowed = [0]) => {
    const r = git(args);
    if (!r || r.error || !allowed.includes(r.status)) throw new Error('git-unverifiable');
    return r;
  };
  const rev = (name) => {
    const sha = String(call(['rev-parse', '--verify', '--end-of-options', `${name}^{commit}`]).stdout ?? '').trim();
    if (!SHA.test(sha)) throw new Error('git-unverifiable');
    return sha;
  };
  let main;
  try { main = rev(mainSha); } catch { /* every entry stays needed */ }
  const rows = overlays.map((overlay) => {
    const row = { ref: overlay?.ref, class: 'needed', reason: 'git-unverifiable', sha: null };
    try {
      if (!main || !isSafeBranchName(overlay?.ref)) return row;
      const evidence = refEvidence?.get(overlay.ref);
      // Omitted evidence is unknown freshness, not permission to trust cached tracking refs.
      if (!['refreshed', 'missing'].includes(evidence)) return row;
      const tracking = `refs/remotes/origin/${overlay.ref}`;
      // A confirmed absence uses recorded evidence even if deleting the cached tracking ref failed.
      const refs = evidence === 'missing' ? [] : String(call(['for-each-ref', '--format=%(refname) %(objectname)', tracking]).stdout ?? '').trim().split('\n');
      const remote = refs.find((line) => line.startsWith(`${tracking} `))?.split(' ')[1];
      if (evidence === 'refreshed' && !remote) return row;
      // Recorded commits are fallback evidence for absent branches, never for a failed refresh: the registration's
      // own fields (`tipSha`, the last refreshed tip, wins as the newest), else a legacy adopted build's tip.
      // Adopted tips are keyed only by ref and cannot establish evidence for a new registration generation.
      const recorded = overlay.tipSha ?? overlay.sha ?? overlay.headSha
        ?? (overlay.registrationId == null ? recordedShas?.get(overlay.ref) : undefined);
      if (!remote && !SHA.test(recorded ?? '')) return row;
      row.sha = rev(remote || recorded);
      if (call(['merge-base', '--is-ancestor', row.sha, main], [0, 1]).status === 0) {
        return { ...row, class: 'landed', reason: 'ancestor-of-main' };
      }
      const lines = String(call(['cherry', main, row.sha]).stdout ?? '').trim().split('\n').filter(Boolean);
      // Cherry is historical and omits merges: reverted patches and merge resolutions need current-tree proof.
      const patchEquivalent = lines.length > 0 && lines.every((line) => /^- [0-9a-f]+$/.test(line));
      const merge = call(['merge-tree', '--write-tree', '--no-messages', main, row.sha], [0, 1]);
      if (merge.status === 0) {
        const mergedTree = String(merge.stdout ?? '').split('\n')[0].trim();
        if (!SHA.test(mergedTree)) throw new Error('git-unverifiable');
        const tree = String(call(['rev-parse', '--verify', `${main}^{tree}`]).stdout ?? '').trim();
        if (!SHA.test(tree)) throw new Error('git-unverifiable');
        if (mergedTree === tree) {
          return { ...row, class: 'landed', reason: patchEquivalent ? 'landed-by-content' : 'main-tree-equivalent' };
        }
      }
      row.reason = 'unmerged-content';
    } catch { row.reason = 'git-unverifiable'; }
    return row;
  });
  const candidates = rows.filter((r) => r.reason === 'unmerged-content');
  const ancestors = new Map();
  const uncertain = new Set();
  for (const a of candidates) for (const b of candidates) {
    if (a === b) continue;
    try { ancestors.set(`${a.ref}\n${b.ref}`, call(['merge-base', '--is-ancestor', a.sha, b.sha], [0, 1]).status === 0); }
    catch { uncertain.add(a); uncertain.add(b); }
  }
  const contains = (a, b) => ancestors.get(`${a.ref}\n${b.ref}`) === true;
  // Preparation excludes unavailable refs from the plan, even when their recorded commits prove containment.
  // Elect maxima only among refreshed carriers so a missing larger/equal tip cannot displace an available one.
  const carriers = candidates.filter((r) => refEvidence?.get(r.ref) === 'refreshed');
  // Strict maxima stay registered. Equal tips elect the last eligible registration, preventing mutual retirement.
  const tops = carriers.filter((a, i) => !carriers.some((b, j) => a !== b && contains(a, b) && (!contains(b, a) || j > i)));
  for (const a of candidates) {
    if (uncertain.has(a)) { a.reason = 'git-unverifiable'; continue; }
    const container = tops.find((b) => a !== b && !uncertain.has(b) && contains(a, b));
    if (container) Object.assign(a, { class: 'contained', reason: 'stack-contained', container: container.ref });
  }
  return rows;
}

/**
 * Best-effort retirement; list mutex guards both source and container registration identities. In 'on' mode a
 * `retiring` audit line (ref, sha, reason) is written BEFORE removal, and no removal happens if it cannot be;
 * a later `removed` line or `overlay-retired` event that fails lands in `auditFailures` for the caller to alert.
 * A contained source moves into its container's `retiredSources`, so removing the container later reinstates it.
 * Sources reinstated by this run's own removals are listed in `reinstated`; this run fetched none of them.
 * Contained pins and `protectedRefs` remain registered for planner and verified swap cleanup checks.
 */
export async function autoRetireOverlays({
  root, env = process.env, overlays, git, mainSha, refEvidence, recordedShas, now = Date.now,
  removeOverlay = removeDefault, appendOverlayEvent = auditDefault, appendDaemonEvent = eventDefault,
  persistTipShas = persistTipsDefault,
  protectedRefs = new Set(),
}) {
  const { mode, source } = resolveAutoRetireMode(env, { now });
  const result = { retired: [], wouldRetire: [], kept: [], auditFailures: [], reinstated: [] };
  if (mode === 'off') {
    result.kept = overlays.map((o) => ({ ref: o?.ref, class: 'needed', reason: 'auto-retire-disabled', sha: null }));
    return result;
  }
  const registrations = new Map(overlays.map((o) => [o?.ref, registrationIdentity(o)]));
  const rows = classifyOverlays({ overlays, git, mainSha, refEvidence, recordedShas });
  for (const row of rows) {
    if (row.class === 'needed') { result.kept.push(row); continue; }
    const event = { ref: row.ref, by: 'auto-retire', reason: row.reason, sha: row.sha };
    try {
      // Verified swap cleanup owns its registrations. Containment alone also cannot replace the planner's
      // pin checks: a containing tip may omit the older mechanism the running build still carries.
      if (protectedRefs.has(row.ref) || (row.class === 'contained'
        && pinnedStatus((args) => {
          const result = git(args);
          if (!result || result.error) throw new Error('pin-unverifiable');
          return result;
        }, overlays.find((o) => o?.ref === row.ref), mainSha ?? 'origin/main', row.sha).pinned)) {
        result.kept.push(row);
        continue;
      }
      if (mode === 'shadow') {
        appendOverlayEvent(root, { ...event, kind: 'auto-retire-shadow', mode, source }, { env });
        result.wouldRetire.push(row);
        continue;
      }
      appendOverlayEvent(root, { ...event, kind: 'retiring', ...(row.container ? { container: row.container } : {}) }, { env });
      const removed = removeOverlay(root, row.ref, {
        env, why: row.reason, expectedOverlay: overlays.find((o) => o?.ref === row.ref),
        ...(row.container ? {
          requireRef: row.container, expectedRequiredOverlay: overlays.find((o) => o?.ref === row.container),
          retireInto: true, retiredSha: row.sha,
        } : {}),
      });
      if (!removed.removed) { result.kept.push(row); continue; }
      result.retired.push(row);
      result.reinstated.push(...(removed.reinstated ?? []));
    } catch {
      result.kept.push({ ...row, reason: 'retirement-unverifiable' });
      continue;
    }
    try { appendOverlayEvent(root, { ...event, kind: 'removed' }, { env }); }
    catch (error) { result.auditFailures.push({ ref: row.ref, kind: 'removed', error: String(error?.message || error) }); }
    try {
      await appendDaemonEvent({ kind: 'overlay-retired', daemon: env.WE_DAEMON_NAME || basename(root), detail: { ref: row.ref, reason: row.reason } }, { env });
    } catch (error) { result.auditFailures.push({ ref: row.ref, kind: 'overlay-retired', error: String(error?.message || error) }); }
  }
  // Only a tip this run refreshed is evidence; a cached tracking ref (no refEvidence) never is.
  const tips = new Map(rows.filter((r) => refEvidence?.get(r.ref) === 'refreshed' && SHA.test(r.sha ?? '')
    && !result.retired.includes(r)).map((r) => [r.ref, { sha: r.sha, reg: registrations.get(r.ref) }]));
  if (tips.size) {
    try { persistTipShas(root, tips, { env }); }
    catch (error) { result.auditFailures.push({ ref: null, kind: 'tip-sha', error: String(error?.message || error) }); }
  }
  return result;
}
