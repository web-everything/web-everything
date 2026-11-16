/**
 * R951 — forge-disk-prune. Forge's root disk reached 100% because forge-cache-prune refused every run for 4 days
 * (469 refusals, "Invalid reserved lock evidence") and nothing alerted. This smell reads the Forge telemetry the Mac
 * already receives (`<lock root>/remote/health.json`, written by forge-remote-health): `telemetry.diskUsedPct` (root
 * disk used %) and `telemetry.prune.{consecutiveRefused,lastRefusal}`. It raises a needs-you finding at >= 80% used
 * or >= 3 consecutive prune refusals. No health file (ENOENT) = host not using Forge remotely = not applicable. FAILS CLOSED: missing/unreadable fields raise a low-severity "unobservable"
 * note, never silence. It makes no ssh call of its own: one bounded local file read per tick.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { admissionLockRoot } from '../../readiness/heavy-admission.mjs';

export const DISK_USED_PCT_MAX = 80;
export const PRUNE_REFUSED_MAX = 3;

function defaultReadForgeHealth() {
  return JSON.parse(readFileSync(join(admissionLockRoot(process.cwd()), 'remote', 'health.json'), 'utf8'));
}
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

export default {
  id: 'forge-disk-prune', scope: 'host', cadence: 'every-tick', probes: [],
  openAfter: 1, closeAfter: 2, severity: 'high', action: 'alert',
  recommendationHint: 'Forge disk is filling or its cache prune keeps refusing; see the refusal line.',
  evaluate(_probes, { readForgeHealth = defaultReadForgeHealth } = {}) {
    let t = null, why = 'no forge telemetry';
    try { t = readForgeHealth()?.telemetry ?? null; } catch (e) {
      // No health file at all = this host has never read Forge remotely: not applicable, nothing to observe.
      if (e?.code === 'ENOENT') return [];
      why = `telemetry unreadable (${String(e?.message ?? e).slice(0, 80)})`;
    }
    const used = num(t?.diskUsedPct);
    const refused = num(t?.prune?.consecutiveRefused);
    if (used === null || refused === null) {
      return [{
        subject: 'forge-disk-prune-unobservable', breach: true, severity: 'low',
        measure: { observable: false, diskUsedPct: used, consecutiveRefused: refused },
        summary: `Forge disk/prune unobservable (${t ? 'telemetry lacks diskUsedPct or prune.consecutiveRefused' : why}); disk fill and prune refusals cannot be seen.`,
        recommendation: 'Deploy the Forge-side telemetry fields (diskUsedPct, prune.consecutiveRefused, prune.lastRefusal); until then check Forge disk and the prune service by hand.',
      }];
    }
    const last = typeof t.prune.lastRefusal === 'string' ? t.prune.lastRefusal.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200) : 'none recorded';
    const diskHigh = used >= DISK_USED_PCT_MAX, pruneStuck = refused >= PRUNE_REFUSED_MAX;
    const reasons = [diskHigh && `root disk ${Math.round(used)}% used (limit ${DISK_USED_PCT_MAX}%)`, pruneStuck && `cache prune refused ${refused} consecutive runs`].filter(Boolean);
    const breach = diskHigh || pruneStuck;
    return [{
      subject: 'forge-disk-prune', breach,
      measure: { diskUsedPct: used, consecutiveRefused: refused, lastRefusal: last },
      summary: breach
        ? `Forge ${reasons.join(' and ')}; disk ${Math.round(used)}%; last prune refusal: ${last}.`
        : `Forge disk ${Math.round(used)}% used, prune refusals ${refused} (ok).`,
      recommendation: 'Run forge-cache-prune dry-run on Forge, fix the refusal named above, then free the cache; Forge root deploys are the operator\'s.',
      ...(breach ? { escalation: { humanOnly: true, status: 'needs-you', reason: 'Forge disk is filling or its cache prune is refusing' } } : {}),
    }];
  },
};
