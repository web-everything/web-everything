/** Shared prepare identity and duplicate-launch guards. Pure: callers supply observed state. */
import { normNum } from './queue-store.mjs';

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const newestFirst = (a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''));

export function isPreparePrFor(pr, { num, bornAs }) {
  if (!pr || pr.isCrossRepository) return false;
  const key = normNum(num);
  if (!key) return false;
  const ids = [key, normNum(bornAs)].filter(Boolean).map(escapeRegex).join('|');
  return new RegExp(`^lane/(?:${ids})[a-z]?-prepare-`).test(pr.headRefName ?? '')
    || new RegExp(`^WE #${escapeRegex(key)}: prepare\\b`).test(pr.title ?? '');
}

export function preparePrGuard({ num, bornAs, prs = [], lastDispatchAt }) {
  return prs.filter(pr => isPreparePrFor(pr, { num, bornAs })
    && (pr.state === 'OPEN' || (pr.state === 'MERGED' && (!lastDispatchAt || pr.createdAt >= lastDispatchAt))))
    .sort(newestFirst)[0] ?? null;
}

export function prepareLaunchRefusal({ num, bornAs, prs = [], lastDispatchAt,
  now = Date.now(), mergedGuardHours = 24, claims = [], liveRows = [], ledgerFailures = [] }) {
  const matching = prs.filter(pr => isPreparePrFor(pr, { num, bornAs })).sort(newestFirst);
  const open = matching.find(pr => pr.state === 'OPEN');
  if (open) return { reason: `open prepare PR #${open.number} (${open.headRefName})` };
  const merged = lastDispatchAt && preparePrGuard({ num, bornAs, prs: matching, lastDispatchAt });
  const mergedAge = merged ? now - Date.parse(merged.createdAt) : NaN;
  if (mergedGuardHours > 0 && mergedAge >= 0 && mergedAge <= mergedGuardHours * 3_600_000) {
    return { reason: `merged prepare PR #${merged.number} after last dispatch (within ${mergedGuardHours}h guard)` };
  }
  const key = normNum(num);
  const claim = claims.find(c => normNum(c.meta?.num) === key);
  if (claim) return { reason: `live prepare claim (${claim.owner})` };
  const row = liveRows.find(r => normNum(r.num) === key);
  if (row) return { reason: `live prepare run (${row.runId ?? row.row?.runId})` };
  // Pick the latest record BEFORE testing its hold/release flags; an old park must not resurface.
  const latest = ledgerFailures.filter(f => normNum(f.num) === key)
    .sort((a, b) => String(b.recordedAt ?? '').localeCompare(String(a.recordedAt ?? '')))[0];
  if (latest?.holdReason?.startsWith('needs-you') && (latest.held === true || latest.completed === true)
    && !latest.releasedAt && !latest.releasedBy) {
    return { reason: `parked needs-you: ${latest.holdReason.slice(0, 120)}` };
  }
  return null;
}
