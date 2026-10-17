/** Shared prepare identity and duplicate-launch guards. Pure: callers supply observed state. */
import { normNum } from './queue-store.mjs';
import { releasedAttempt } from './prepare-failure-policy.mjs';

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const newestFirst = (a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''));

const batchMembers = pr => {
  const match = /^prepare: ([a-z0-9]+(?:, [a-z0-9]+)*)$/.exec(pr.title ?? '');
  return match && match[0] === pr.title ? match[1].split(', ') : null;
};

/**
 * Write grade: a same-repo PR from the card's own lane prepare branch, or a batch branch whose lead/count
 * agree with its exact, unique title membership. Only this may drive a stamp, a hold or a
 * claim retirement (PR #5366 round 7): a title is free text any collaborator can type on any branch.
 */
export function isLanePreparePrFor(pr, { num, bornAs }) {
  if (!pr || pr.isCrossRepository) return false;
  const key = normNum(num);
  if (!key) return false;
  const aliases = [key, normNum(bornAs)].filter(Boolean);
  const batch = /^lane\/prepare-batch-([a-z0-9]+)-([1-9][0-9]*)$/.exec(pr.headRefName ?? '');
  if (batch) {
    const members = batchMembers(pr);
    return Boolean(batch[0] === pr.headRefName && members && members[0] === batch[1] && String(members.length) === batch[2]
      && new Set(members).size === members.length && aliases.some(id => members.includes(id)));
  }
  const ids = aliases.map(escapeRegex).join('|');
  return new RegExp(`^lane/(?:${ids})[a-z]?-prepare-`).test(pr.headRefName ?? '');
}

/** Refusal grade: the lane branch OR a `WE #<num>: prepare` title. Enough to refuse a duplicate launch, never to write. */
export function isPreparePrFor(pr, { num, bornAs }) {
  if (isLanePreparePrFor(pr, { num, bornAs })) return true;
  if (!pr || pr.isCrossRepository) return false;
  const key = normNum(num);
  const batch = batchMembers(pr);
  if (batch?.includes(key)) return true;
  return Boolean(key) && new RegExp(`^WE #${escapeRegex(key)}: prepare\\b`).test(pr.title ?? '');
}

export function preparePrGuard({ num, bornAs, prs = [], lastDispatchAt }) {
  return prs.filter(pr => isPreparePrFor(pr, { num, bornAs })
    && (pr.state === 'OPEN' || (pr.state === 'MERGED' && (!lastDispatchAt || pr.createdAt >= lastDispatchAt))))
    .sort(newestFirst)[0] ?? null;
}

export function prepareLaunchRefusal({ num, bornAs, prs = [],
  now = Date.now(), mergedGuardHours = 24, claims = [], liveRows = [], ledgerFailures = [], releases = [] }) {
  const matching = prs.filter(pr => isPreparePrFor(pr, { num, bornAs })).sort(newestFirst);
  const open = matching.find(pr => pr.state === 'OPEN');
  if (open) return { reason: `open prepare PR #${open.number} (${open.headRefName})` };
  // A slow review does not consume the post-merge guard. Inspect every matching merge:
  // creation order need not match merge order, and dispatch history may not survive a restart.
  const merged = recentMergedPrepare({ num, bornAs, prs, now, mergedGuardHours });
  if (merged) return { reason: `merged prepare PR #${merged.pr.number} (within ${mergedGuardHours}h guard)` };
  const key = normNum(num);
  const claim = claims.find(c => normNum(c.meta?.num) === key);
  if (claim) return { reason: `live prepare claim (${claim.owner})` };
  const row = liveRows.find(r => normNum(r.num) === key);
  if (row) return { reason: `live prepare run (${row.runId ?? row.row?.runId})` };
  // Pick the latest record BEFORE testing its hold/release flags; an old park must not resurface.
  const latest = ledgerFailures.filter(f => normNum(f.num) === key)
    .sort((a, b) => String(b.recordedAt ?? '').localeCompare(String(a.recordedAt ?? '')))[0];
  // Same `held && !completed` view as the needs-you list: a stamp on main completes the record and resolves the park.
  if (latest?.holdReason?.startsWith('needs-you') && latest.held === true && latest.completed !== true
    && !latest.releasedAt && !latest.releasedBy && !releasedAttempt(releases, key, latest.attempt)) {
    return { reason: `parked needs-you: ${latest.holdReason.slice(0, 120)}` };
  }
  return null;
}

/** Shared post-merge cooldown, measured from merge time rather than PR creation. */
export function recentMergedPrepare({ num, bornAs, prs = [], now = Date.now(), mergedGuardHours = 24 }) {
  const merged = prs.filter(pr => isPreparePrFor(pr, { num, bornAs })).filter(pr => pr.state === 'MERGED')
    .map(pr => ({ pr, at: Date.parse(pr.mergedAt ?? pr.closedAt ?? pr.createdAt) }))
    .filter(({ at }) => mergedGuardHours > 0 && now - at >= 0 && now - at <= mergedGuardHours * 3_600_000)
    .sort((a, b) => b.at - a.at)[0];
  return merged ? { pr: merged.pr, minutesAgo: Math.floor((now - merged.at) / 60_000) } : null;
}
