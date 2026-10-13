/** Convert CLI PR fixtures into the light GraphQL connection served by hermetic gh shims. */
export function openPrPageFixture(prs, query) {
  const size = Number(/first:(\d+)/.exec(query)?.[1] || 20);
  const cursor = /after:("(?:\\.|[^"\\])*")/.exec(query);
  const start = cursor ? Number(JSON.parse(cursor[1])) : 0;
  const end = Math.min(start + size, prs.length);
  const nodes = prs.slice(start, end).map(p => ({
    number: p.number, title: p.title, url: p.url || '', isDraft: p.isDraft || false,
    createdAt: p.createdAt || '2026-10-09T00:00:00Z', updatedAt: p.updatedAt || '2026-10-09T00:00:00Z',
    headRefName: p.headRefName, headRefOid: p.headRefOid, baseRefName: p.baseRefName,
    isCrossRepository: p.isCrossRepository || false, mergeable: p.mergeable,
    mergeStateStatus: p.mergeStateStatus, reviewDecision: p.reviewDecision || '',
    labels: { nodes: p.labels || [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes:
      (p.statusCheckRollup || []).map(c => c.context
        ? { ...c, __typename: 'StatusContext', createdAt: c.createdAt || c.startedAt }
        : { ...c, __typename: 'CheckRun',
          checkSuite: { workflowRun: { workflow: { name: c.workflowName || '' } } } }),
    } } } }] },
  }));
  return { data: { repository: { pullRequests: { totalCount: prs.length,
    pageInfo: { hasNextPage: end < prs.length, endCursor: end < prs.length ? String(end) : null }, nodes,
  } } } };
}
