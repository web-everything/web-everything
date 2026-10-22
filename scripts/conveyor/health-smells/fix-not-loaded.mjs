/**
 * @file scripts/conveyor/health-smells/fix-not-loaded.mjs
 * A green, audited fix is ready but no daemon clone carries it.
 *
 * THE RULE (pure, over `fixReady` + `selfSync`): after readyMinutes, alert unless the
 * fix is an ancestor of a daemon HEAD, appears in a live adopted rebuild's applied list,
 * or has an operator load-skip quote. Short SHAs match in either direction, ignoring case.
 *
 * SETTINGS: `scripts/settings/fix-not-loaded.json` `fixNotLoaded.readyMinutes`
 * (built-in 30), probe `lookbackDays` (built-in 7), and `probeBudgetMs`
 * (built-in 15000), through `scripts/lib/settings-files.mjs`.
 */
import { MINUTE, fmtAge } from '../health-watch-core.mjs';
import { readSettings } from '../../lib/settings-files.mjs';

export const FIX_NOT_LOADED_BUILT_IN = Object.freeze({ readyMinutes: 30, lookbackDays: 7, probeBudgetMs: 15000 });
export function resolveFixNotLoadedSettings(file) {
  return Object.fromEntries(Object.entries(FIX_NOT_LOADED_BUILT_IN).map(([key, fallback]) => {
    const v = Number(file?.fixNotLoaded?.[key]);
    return [key, Number.isFinite(v) && v > 0 ? v : fallback];
  }));
}
let settings = FIX_NOT_LOADED_BUILT_IN;
try { settings = resolveFixNotLoadedSettings(readSettings()); } catch { /* built-in */ }

const validSha = (sha) => typeof sha === 'string' && /^[a-f0-9]{7,}$/i.test(sha);
const matchesSha = (a, b) => validSha(a) && validSha(b)
  && (a.toLowerCase().startsWith(b.toLowerCase()) || b.toLowerCase().startsWith(a.toLowerCase()));
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

export function appliedFixClones(record, selfSync) {
  return (selfSync || []).filter((c) => {
    const adopted = c.rebuild?.adopted;
    if (Array.isArray(record.liveHeads) && !record.liveHeads.some((head) => matchesSha(adopted?.head, head))) return false;
    return Array.isArray(adopted?.applied) && adopted.applied.some((a) => matchesSha(record.sha, a?.sha));
  }).map((c) => c.cloneKey);
}

/** PURE: rows for overdue fixes with no observed load and no operator exception. */
export function notLoadedFixes(records, selfSync, { now, readyMs }) {
  return (records || []).flatMap((r) => {
    const ageMs = now - Date.parse(r.at);
    if (!Number.isFinite(ageMs) || ageMs <= readyMs
      || (typeof r.loadSkipQuote === 'string' && r.loadSkipQuote.trim())
      || r.ancestorOf?.length || appliedFixClones(r, selfSync).length) return [];
    return [{
      subject: `fix-not-loaded:${r.ref}`, breach: true,
      measure: { ref: r.ref, sha: r.sha, readyAtIso: new Date(r.at).toISOString(), ageMs, audit: r.audit, unknown: !!r.unknown },
      summary: `Fix ${r.ref} (${r.sha}) has been ready for ${fmtAge(ageMs)}; ${r.unknown ? 'load could not be verified this tick (probe budget spent)' : 'no daemon clone carries it'}.`,
      recommendation: `Load ${shellQuote(r.ref)} on the daemon prototype via the sanctioned overlay load; never hand-edit a clone. Or record an operator load-skip quote with node scripts/fix-ready.mjs mark --ref=${shellQuote(r.ref)} --sha=${shellQuote(r.sha)} --tests=green --audit=${shellQuote(r.audit)} --load-skip-quote="<operator quote>".`,
    }];
  });
}

export default {
  id: 'fix-not-loaded', scope: 'host', cadence: 'every-tick', probes: ['fixReady', 'selfSync'],
  openAfter: 1, closeAfter: 2, severity: 'high', action: 'alert',
  readyMs: settings.readyMinutes * MINUTE,
  evaluate({ fixReady, selfSync }, { now }) {
    return notLoadedFixes(fixReady, selfSync, { now, readyMs: this.readyMs });
  },
};
