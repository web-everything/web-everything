/**
 * R951 — forge-disk-prune. Forge's root disk reached 100% because forge-cache-prune refused every run for 4 days
 * (469 refusals, "Invalid reserved lock evidence") and nothing alerted. This smell reads the Forge telemetry the Mac
 * already receives (`<lock root>/remote/health.json`, written by forge-remote-health): `telemetry.diskUsedPct` (root
 * disk used %) and `telemetry.prune.{consecutiveRefused,lastRefusal}`. It raises a needs-you finding at >= 80% used
 * or >= 3 consecutive prune refusals. Sticky (R952): an open needs-you stays needs-you while telemetry is missing. Invalid values (negative, non-numeric, >100%) count as missing. A missing file is a note too (never closes an open episode without a healthy reading); only under test is it not applicable. One subject for breach and note so an open needs-you episode never closes on missing evidence. FAILS CLOSED: missing/unreadable fields raise a low-severity "unobservable"
 * note, never silence. It makes no ssh call of its own: one bounded local file read per tick.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { admissionLockRoot } from '../../readiness/heavy-admission.mjs';

export const DISK_USED_PCT_MAX = 80;
export const PRUNE_REFUSED_MAX = 3;
export const TELEMETRY_MAX_AGE_MS = 15 * 60 * 1000; // older samples are not evidence of health

function defaultReadForgeHealth() {
  return JSON.parse(readFileSync(join(dirname(admissionLockRoot(process.cwd())), 'remote', 'health.json'), 'utf8'));
}
// A valid reading is a finite number >= 0 (and <= max when given); anything else is an invalid reading = unobservable.
const num = (x, max = Infinity) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= max ? x : null);

export default {
  id: 'forge-disk-prune', scope: 'host', cadence: 'every-tick', probes: [],
  openAfter: 1, closeAfter: 2, severity: 'high', action: 'alert',
  recommendationHint: 'Forge disk is filling or its cache prune keeps refusing; see the refusal line.',
  evaluate(_probes, { readForgeHealth = defaultReadForgeHealth, now = Date.now(), episodes = {} } = {}) {
    let t = null, why = 'no forge telemetry';
    try { t = readForgeHealth()?.telemetry ?? null; } catch (e) {
      // Under test the lock root is a throwaway dir with no Forge file: not applicable. In production a missing file is a note.
      if (e?.code === 'ENOENT' && process.env.VITEST) return [];
      if (e?.code === 'ENOENT') why = 'no remote health file';
      else       why = `telemetry unreadable (${String(e?.message ?? e).slice(0, 80)})`;
    }
    const used = num(t?.diskUsedPct, 100);
    const refused = num(t?.prune?.consecutiveRefused);
    const last = typeof t?.prune?.lastRefusal === 'string' ? t.prune.lastRefusal.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200) : 'none recorded';
    const diskHigh = used !== null && used >= DISK_USED_PCT_MAX, pruneStuck = refused !== null && refused >= PRUNE_REFUSED_MAX;
    const age = now - Date.parse(t?.sampledAtET);
    const stale = !Number.isFinite(age) || age > TELEMETRY_MAX_AGE_MS || age < -TELEMETRY_MAX_AGE_MS;
    if (diskHigh || pruneStuck) {
      const reasons = [diskHigh && `root disk ${Math.round(used)}% used (limit ${DISK_USED_PCT_MAX}%)`, pruneStuck && `cache prune refused ${refused} consecutive runs`].filter(Boolean);
      return [{
        subject: 'forge-disk-prune', breach: true,
        measure: { diskUsedPct: used, consecutiveRefused: refused, lastRefusal: last, stale },
        summary: `Forge ${reasons.join(' and ')}; disk ${used === null ? 'unknown' : Math.round(used) + '%'}; last prune refusal: ${last}.`,
        recommendation: 'Run forge-cache-prune dry-run on Forge, fix the refusal named above, then free the cache; Forge root deploys are the operator\'s.',
        escalation: { humanOnly: true, status: 'needs-you', reason: 'Forge disk is filling or its cache prune is refusing' },
      }];
    }
    if (used === null || refused === null || stale) {
      // R952 sticky breach: an open needs-you episode stays needs-you until a valid healthy reading clears it.
      if (episodes['forge-disk-prune::forge-disk-prune']?.escalation?.status === 'needs-you') {
        return [{
          subject: 'forge-disk-prune', breach: true,
          measure: { observable: false, diskUsedPct: used, consecutiveRefused: refused, stale },
          summary: 'Forge disk/prune breach open, telemetry now missing; the earlier needs-you stays raised until a valid healthy reading.',
          recommendation: 'Restore Forge telemetry or check Forge disk and the prune service by hand; the breach clears only on a valid healthy reading.',
          escalation: { humanOnly: true, status: 'needs-you', reason: 'breach open, telemetry now missing' },
        }];
      }
      return [{
        subject: 'forge-disk-prune', breach: true, severity: 'low',
        measure: { observable: false, diskUsedPct: used, consecutiveRefused: refused, stale },
        summary: `Forge disk/prune unobservable (${!t ? why : stale ? 'telemetry sample is stale or undated' : 'telemetry lacks diskUsedPct or prune.consecutiveRefused'}); disk fill and prune refusals cannot be seen.`,
        recommendation: 'Deploy the Forge-side telemetry fields (diskUsedPct, prune.consecutiveRefused, prune.lastRefusal) or restore telemetry reads; until then check Forge disk and the prune service by hand.',
      }];
    }
    return [{
      subject: 'forge-disk-prune', breach: false,
      measure: { diskUsedPct: used, consecutiveRefused: refused, lastRefusal: last },
      summary: `Forge disk ${Math.round(used)}% used, prune refusals ${refused} (ok).`,
      recommendation: 'No action.',
    }];
  },
};
