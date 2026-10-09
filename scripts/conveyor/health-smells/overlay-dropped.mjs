/**
 * Held item 168 (2026-10-09) — health-watch sign for a REGISTERED overlay that the daemon rebuild left OUT of the
 * clone's HEAD. The rebuild (`we:scripts/lib/daemon-rebuild/plan.mjs`) conflict-drops an overlay that does not merge
 * cleanly this pass and keeps it registered, logging `overlay-conflict-dropped` (and `overlay-conflict-unresolved`
 * with the conflicting files) on every rebuild attempt. Nothing surfaced it: live fixes silently left the daemon —
 * #4510 push-on-green was off for hours, #4527 main-red owner and #4560 supersede were dropped tonight, all on
 * `scripts/dispatch-settings.json`, the one JSON file every feature appended keys to.
 *
 * THE RULE (pure, over the `selfSync` probe — `~/.claude/daemon-self-sync-state/<cloneKey>.alerts.jsonl` + `.rebuild.json`):
 *   an overlay is DROPPED when its latest drop alert (`overlay-conflict-dropped` or `pinned-overlay-conflict-skipped`)
 *   is fresh (within `freshMs`: the rebuild re-logs it every attempt while it stays registered), is newer than any
 *   `overlay-auto-dropped` (unregistered: merged / closed / gone), and the adopted build's `applied` list — what the
 *   clone's HEAD carries — does not name it. The sign names the overlay, its PR and the conflicting files.
 *   A conflict only in JSON settings files is a SHARED-SETTINGS conflict: the PR rebases, and existing keys are NOT
 *   moved (readers in `LEGACY_ONLY_READERS` read only the legacy file); a NEW key whose reader goes through
 *   `readSettings()` goes in its own `scripts/settings/<feature>.json`. Anything else is a real code conflict and the PR must rebase.
 *
 * SETTINGS: `we:scripts/settings/overlay-dropped.json` `overlayDropped.freshMinutes` (built-in 30), read through
 *   `we:scripts/lib/settings-files.mjs`.
 */
import { MINUTE, fmtAge } from '../health-watch-core.mjs';
import { readSettings, LEGACY_ONLY_READERS } from '../../lib/settings-files.mjs';

export const OVERLAY_DROPPED_BUILT_IN = Object.freeze({ freshMinutes: 30 });

/** Resolve the smell's settings from a merged settings object. Never throws. */
export function resolveOverlayDroppedSettings(file) {
  const v = Number(file?.overlayDropped?.freshMinutes);
  return { freshMinutes: Number.isFinite(v) && v > 0 ? v : OVERLAY_DROPPED_BUILT_IN.freshMinutes };
}

let settings = OVERLAY_DROPPED_BUILT_IN;
try { settings = resolveOverlayDroppedSettings(readSettings()); } catch { /* built-in */ }

const DROP_KINDS = new Set(['overlay-conflict-dropped', 'pinned-overlay-conflict-skipped']);
const isSettingsFile = (f) => /\.json$/.test(f) && /(^|\/)(settings\/[^/]+|[^/]*settings[^/]*)\.json$/.test(f);

/**
 * PURE: the advice for a settings-only conflict. The fix is always a rebase. Moving keys out of the legacy file is
 * offered ONLY for a NEW key whose reader goes through `readSettings`: the readers in `LEGACY_ONLY_READERS` read
 * the legacy file alone, so a key moved from it into a feature file silently falls back to their default.
 */
function settingsConflictAdvice(d, files) {
  const legacy = d.files.some((f) => /(^|\/)scripts\/dispatch-settings\.json$|^dispatch-settings\.json$/.test(f));
  if (!legacy) return `Settings conflict on ${files}: rebase ${d.ref} onto main; the next rebuild re-applies it. Never hand-edit the clone.`;
  return `Shared-settings conflict on ${files}: rebase ${d.ref} onto main; the next rebuild re-applies it. Do NOT move existing keys out of scripts/dispatch-settings.json — ${LEGACY_ONLY_READERS.join(', ')} read only that file and would silently fall back to their defaults. Only a NEW key whose reader goes through readSettings() (scripts/lib/settings-files.mjs) belongs in its own scripts/settings/<feature>.json. Never hand-edit the clone.`;
}

/**
 * PURE: the dropped overlays of one clone.
 * @param {{alerts?:Array<{at:number|null, kind:string, detail?:object}>, rebuild?:{adopted?:{applied?:Array<{ref:string}>, head?:string, at?:number|null}}|null}} clone
 * @param {{now:number, freshMs:number}} o
 * @returns {Array<{ref:string, pr:number|null, droppedAt:number, files:string[], settingsOnly:boolean, sha:string|null}>}
 */
export function droppedOverlays(clone, { now, freshMs }) {
  const applied = new Set((clone?.rebuild?.adopted?.applied ?? []).map((a) => a?.ref).filter(Boolean));
  const byRef = new Map();
  const get = (ref) => {
    if (!byRef.has(ref)) byRef.set(ref, { dropAt: null, removedAt: null, files: [], pr: null, sha: null });
    return byRef.get(ref);
  };
  for (const a of clone?.alerts ?? []) {
    const ref = a?.detail?.ref;
    if (!ref || !Number.isFinite(a.at)) continue;
    const r = get(ref);
    if (a.detail.pr != null) r.pr = a.detail.pr;
    if (DROP_KINDS.has(a.kind)) r.dropAt = Math.max(r.dropAt ?? 0, a.at);
    else if (a.kind === 'overlay-auto-dropped') r.removedAt = Math.max(r.removedAt ?? 0, a.at);
    else if (a.kind === 'overlay-conflict-unresolved') {
      r.files = Array.isArray(a.detail.files) ? a.detail.files.map(String) : [];
      r.sha = a.detail.sha ?? r.sha;
    }
  }
  const out = [];
  for (const [ref, r] of byRef) {
    if (r.dropAt == null) continue;
    if (now - r.dropAt > freshMs) continue;
    if (r.removedAt != null && r.removedAt >= r.dropAt) continue;
    if (applied.has(ref)) continue;
    out.push({
      ref, pr: r.pr, droppedAt: r.dropAt, files: r.files, sha: r.sha,
      settingsOnly: r.files.length > 0 && r.files.every(isSettingsFile),
    });
  }
  return out.sort((a, b) => a.ref.localeCompare(b.ref));
}

export default {
  id: 'overlay-dropped',
  scope: 'host',
  cadence: 'every-tick',
  probes: ['selfSync'],
  openAfter: 1,
  closeAfter: 2,
  severity: 'high',
  action: 'alert',
  freshMs: settings.freshMinutes * MINUTE,
  recommendationHint: 'A registered overlay is not in the daemon clone\'s HEAD — the rebuild conflict-dropped it, so its live fix is off the daemon. The PR must rebase onto main (settings-only conflict too: do not move existing keys out of scripts/dispatch-settings.json — some readers see only that file; a NEW key whose reader uses readSettings() goes in scripts/settings/<feature>.json). Never hand-edit the clone.',
  evaluate({ selfSync }, { now }) {
    const rows = [];
    for (const c of selfSync || []) {
      const dropped = droppedOverlays(c, { now, freshMs: this.freshMs });
      for (const d of dropped) {
        const pr = d.pr != null ? ` (PR #${d.pr})` : '';
        const files = d.files.length ? d.files.join(', ') : 'unknown files';
        rows.push({
          subject: `overlay:${c.cloneKey}:${d.ref}`,
          breach: true,
          measure: {
            ref: d.ref, pr: d.pr, sha: d.sha, files: d.files, settingsOnly: d.settingsOnly,
            droppedAtIso: new Date(d.droppedAt).toISOString(), adoptedHead: c.rebuild?.adopted?.head ?? null,
          },
          summary: `overlay ${d.ref}${pr} is registered on clone ${c.cloneKey} but not in its HEAD — the rebuild dropped it ${fmtAge(now - d.droppedAt)} ago (conflict on ${files}); its fix is off the daemon.`,
          recommendation: d.settingsOnly
            ? settingsConflictAdvice(d, files)
            : `Real code conflict on ${files}: ${d.ref}${pr} must rebase onto main; the next rebuild re-applies it. Never hand-edit the clone. History: ~/.claude/daemon-self-sync-state/${c.cloneKey}.alerts.jsonl.`,
        });
      }
    }
    return rows;
  },
};
