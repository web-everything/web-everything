/** Convert CLI PR fixtures into the light GraphQL connection served by hermetic gh shims. */
export function openPrPageFixture(prs, query) {
  const size = Number(/first:(\d+)/.exec(query)?.[1] || 20);
  const cursor = /after:("(?:\\.|[^"\\])*")/.exec(query);
  const start = cursor ? Number(JSON.parse(cursor[1])) : 0;
  const end = Math.min(start + size, prs.length);
  const nodes = prs.slice(start, end).map(p => ({
    number: p.number, title: p.title, url: p.url || '', isDraft: p.isDraft || false,
    createdAt: p.createdAt || '2026-10-09T00:00:00Z', updatedAt: p.updatedAt || '2026-10-09T00:00:00Z',
    headRefName: p.headRefName, headRefOid: p.headRefOid, baseRefName: p.baseRefName, baseRefOid: p.baseRefOid,
    isCrossRepository: p.isCrossRepository || false, mergeable: p.mergeable,
    mergeStateStatus: p.mergeStateStatus, reviewDecision: p.reviewDecision || '',
    labels: { nodes: p.labels || [] },
    commits: { nodes: [{ commit: { oid: p.headRefOid, statusCheckRollup: { contexts: {
      totalCount: (p.statusCheckRollup || []).length, pageInfo: { hasNextPage: false, endCursor: null }, nodes:
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

/** Complete, slurped commit-history pages; identities and commits come from the selected PR. */
export function prCommitsPageFixture(prs, args) {
  if (args[0] !== 'api' || args[1] !== 'graphql'
    || !args.some(a => a.includes('pullRequest(number:') && a.includes('commits(first:100'))) return undefined;
  const number = Number(args.find(a => a.startsWith('number='))?.slice(7));
  const pr = prs.find(p => p.number === number);
  if (!pr) throw new Error(`Unknown commit-history fixture PR #${number}`);
  const commits = pr.commits;
  return Array.from({ length: Math.max(1, Math.ceil(commits.length / 100)) }, (_, index) => {
    const end = Math.min((index + 1) * 100, commits.length);
    const hasNextPage = end < commits.length;
    return { data: { repository: { pullRequest: { headRefOid: pr.headRefOid, baseRefOid: pr.baseRefOid,
      commits: { totalCount: commits.length, pageInfo: { hasNextPage, endCursor: hasNextPage ? String(end) : null },
        nodes: commits.slice(index * 100, end).map(commit => ({ commit: { ...commit,
          authors: Array.isArray(commit.authors) ? { nodes: commit.authors } : commit.authors } })) },
    } } } };
  });
}
