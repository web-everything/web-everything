/** Overlay retirement uses verified Git evidence; uncertainty preserves registrations. */
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cascadePolicy, logCascadeSources } from './policy-cascade.mjs';
import { removeOverlay as removeDefault, appendOverlayEvent as auditDefault } from './daemon-overlays.mjs';
import { appendDaemonEvent as eventDefault } from './daemon-events.mjs';
import { isSafeBranchName } from './daemon-self-sync.mjs';

const SETTINGS = join(dirname(fileURLToPath(import.meta.url)), 'daemon-rebuild-settings.json');
const SHA = /^[0-9a-f]{40,64}$/;
const time = (now) => new Date(typeof now === 'function' ? now() : now).getTime();

/** Standard → platform → tool → environment; only tool shadow graduates after one full day. */
export function resolveAutoRetireMode(env = process.env, { settingsPath = SETTINGS, now = Date.now } = {}) {
  let tool;
  try { tool = JSON.parse(readFileSync(settingsPath, 'utf8')).autoRetire; } catch { /* unset */ }
  const r = cascadePolicy('autoRetire', tool, {
    env, standard: { mode: 'shadow' },
    envValues: { mode: env?.WE_DAEMON_OVERLAY_AUTO_RETIRE?.trim() || undefined },
    valid: { mode: (v) => ['off', 'shadow', 'on'].includes(v), shadowSince: (v) => typeof v === 'string' && Number.isFinite(Date.parse(v)) },
  });
  const graduated = r.sources.mode === 'tool' && r.value.mode === 'shadow' && time(now) - Date.parse(r.value.shadowSince) >= 86_400_000;
  const mode = graduated ? 'on' : r.value.mode;
  const source = `${r.sources.mode}${graduated ? ' (shadow elapsed)' : ''}`;
  logCascadeSources('autoRetire.effective', { value: { mode }, sources: { mode: source } }, { env });
  return { mode, source, shadowSince: r.value.shadowSince };
}

/** Git runner takes argv and returns spawnSync-shaped results. No worktree or network mutations. */
export function classifyOverlays({ overlays, git, mainSha = 'origin/main', refEvidence }) {
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
      if (refEvidence && !['refreshed', 'missing'].includes(evidence)) return row;
      const tracking = `refs/remotes/origin/${overlay.ref}`;
      // A confirmed absence uses recorded evidence even if deleting the cached tracking ref failed.
      const refs = evidence === 'missing' ? [] : String(call(['for-each-ref', '--format=%(refname) %(objectname)', tracking]).stdout ?? '').trim().split('\n');
      const remote = refs.find((line) => line.startsWith(`${tracking} `))?.split(' ')[1];
      if (evidence === 'refreshed' && !remote) return row;
      // Recorded commits are fallback evidence for absent branches, never for a failed refresh.
      const recorded = overlay.sha ?? overlay.headSha ?? overlay.tipSha;
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
  // Strict maxima stay registered. Equal tips elect the last registration, preventing mutual retirement.
  const tops = candidates.filter((a, i) => !candidates.some((b, j) => a !== b && contains(a, b) && (!contains(b, a) || j > i)));
  for (const a of candidates) {
    if (uncertain.has(a)) { a.reason = 'git-unverifiable'; continue; }
    const container = tops.find((b) => a !== b && !uncertain.has(b) && contains(a, b));
    if (container) Object.assign(a, { class: 'contained', reason: 'stack-contained', container: container.ref });
  }
  return rows;
}

/** Best-effort retirement; list mutex guards both source and container registration identities. */
export async function autoRetireOverlays({
  root, env = process.env, overlays, git, mainSha, refEvidence, now = Date.now,
  removeOverlay = removeDefault, appendOverlayEvent = auditDefault, appendDaemonEvent = eventDefault,
}) {
  const { mode, source } = resolveAutoRetireMode(env, { now });
  const result = { retired: [], wouldRetire: [], kept: [] };
  const rows = classifyOverlays({ overlays, git, mainSha, refEvidence });
  for (const row of rows) {
    if (mode === 'off' || row.class === 'needed') { result.kept.push(row); continue; }
    const event = { ref: row.ref, by: 'auto-retire', reason: row.reason, sha: row.sha };
    try {
      if (mode === 'shadow') {
        appendOverlayEvent(root, { ...event, kind: 'auto-retire-shadow', mode, source }, { env });
        result.wouldRetire.push(row);
        continue;
      }
      const removed = removeOverlay(root, row.ref, {
        env, why: row.reason, expectedOverlay: overlays.find((o) => o?.ref === row.ref),
        ...(row.container ? {
          requireRef: row.container, expectedRequiredOverlay: overlays.find((o) => o?.ref === row.container),
        } : {}),
      });
      if (!removed.removed) { result.kept.push(row); continue; }
      result.retired.push(row);
      appendOverlayEvent(root, { ...event, kind: 'removed' }, { env });
      await appendDaemonEvent({ kind: 'overlay-retired', daemon: env.WE_DAEMON_NAME || basename(root), detail: { ref: row.ref, reason: row.reason } }, { env });
    } catch {
      if (!result.retired.includes(row)) result.kept.push({ ...row, reason: 'retirement-unverifiable' });
    }
  }
  return result;
}
