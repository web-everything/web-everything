const hasPending = labels => Array.isArray(labels)
  && labels.some(label => (typeof label === 'string' ? label : label?.name) === 'red-team:pending');

/** Remove stale pending only after a fresh, same-head draft observation. No verdict is granted. */
export function sweepDraftPendingLabels({ repo, rawPrs, provider, skipKeys = new Set(), log = () => {}, max = 5 }) {
  const result = { dropped: [], skipped: [], errors: [] };
  const cap = Number.isSafeInteger(max) && max >= 0 ? max : 0;
  let attempted = 0;
  for (const row of rawPrs || []) {
    if (row.isDraft !== true || !hasPending(row.labels)) continue;
    const pr = row.number;
    if (skipKeys.has(`${repo}#${pr}`)) { result.skipped.push({ pr, why: 'queue-owned' }); continue; }
    if (attempted >= cap) break;
    attempted++;
    try {
      const fresh = provider.readPrState(repo, pr);
      let why;
      if (fresh?.state !== 'OPEN') why = 'not open';
      else if (fresh.isDraft !== true) why = 'not confirmed draft';
      else if (!row.headRefOid || fresh.headRefOid !== row.headRefOid) why = 'head changed or unreadable';
      else if (!hasPending(fresh.labels)) why = 'pending absent or unreadable';
      if (why) { result.skipped.push({ pr, why }); continue; }
      provider.setLabels(repo, pr, { remove: ['red-team:pending'] });
      result.dropped.push(pr);
    } catch (error) {
      const why = String(error?.message ?? error);
      result.errors.push({ pr, why });
      try { log(`red-team draft pending sweep ${repo}#${pr}: ${why}`.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')); } catch { /* Logging cannot interrupt the sweep. */ }
    }
  }
  return result;
}
