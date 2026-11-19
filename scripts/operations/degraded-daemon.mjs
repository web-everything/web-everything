/** R1075. Pure assessment of the daemon's own coordination log; unknown evidence cannot enable loading. */
import { basename } from 'node:path';

const SIGNALS = new Set(['overlay-adoption-overdue', 'ready-candidate-discarded',
  'ready-candidate-discarded-needs-you', 'REBUILD-DISCARD-LOOP', 'rebuild-discard-loop']);
const ADOPTIONS = new Set(['overlay-adopted', 'rebuild-adopted']);
export function assessDegraded({ events, daemon, clone, now, afterMinutes }) {
  const evidence = { signals: [], lastAdoptionAt: null, ageMinutes: null, afterMinutes };
  const no = () => ({ degraded: false, evidence });
  if (!Number.isFinite(now) || !Number.isFinite(afterMinutes) || afterMinutes <= 0
    || typeof daemon !== 'string' || !daemon || typeof clone !== 'string' || !clone) return no();
  try {
    const rows = typeof events === 'string'
      ? events.split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l)) : events;
    if (!Array.isArray(rows) || !rows.length) return no();
    const own = rows.filter(e => e && (e.daemon === daemon || e.daemon === basename(clone)));
    // A corrupt or future-dated relevant record could hide recovery. Refuse the fast path.
    if (own.some(e => (SIGNALS.has(e.kind) || ADOPTIONS.has(e.kind))
      && (typeof e.at !== 'string' || !Number.isFinite(Date.parse(e.at)) || Date.parse(e.at) > now))) return no();
    const adopted = own.filter(e => ADOPTIONS.has(e.kind)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    evidence.lastAdoptionAt = adopted?.at ?? null;
    evidence.signals = own.filter(e => SIGNALS.has(e.kind) && (!adopted || Date.parse(e.at) > Date.parse(adopted.at)))
      .map(({ kind, at }) => ({ kind, at })).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    if (!evidence.signals.length) return no();
    evidence.ageMinutes = (now - Date.parse(evidence.signals[0].at)) / 60000;
    return { degraded: evidence.ageMinutes >= afterMinutes
      && (!adopted || now - Date.parse(adopted.at) >= afterMinutes * 60000), evidence };
  } catch { return no(); }
}
