/** Pass-start PR view batching only. Merge and label-write revalidation stays live. */
import { cascadePolicy, platformPreference } from './policy-cascade.mjs';
import { readDeclaredSettings } from './settings-files.mjs';

export function resolveDrainPrState({ env = process.env, file, platform, log } = {}) {
  const raw = env.WE_DRAIN_PR_STATE_BATCHED?.trim().toLowerCase();
  const batched = raw ? ({ true: true, false: false, on: true, off: false, 1: true, 0: false }[raw] ?? raw) : undefined;
  return cascadePolicy('drain.prState', (file ?? readDeclaredSettings().settings)?.drain?.prState, {
    standard: { batched: true }, platform: platform ?? platformPreference('drain', { env })?.prState,
    env, log, envValues: { batched }, valid: { batched: v => typeof v === 'boolean' },
  });
}

// Five authors bounds the nested GraphQL node cost; overflow takes the per-PR path.
const selection = `number updatedAt headRefOid body
  files(first:100){pageInfo{hasNextPage} nodes{path additions deletions changeType}}
  commits(first:100){pageInfo{hasNextPage} nodes{commit{oid authoredDate committedDate messageHeadline messageBody
    authors(first:5){pageInfo{hasNextPage} nodes{email name user{id login}}}}}}`;

/** One query across repositories, with pagination of the open set. Any failed page discards the batch.
 * Nested connections that need more pages use the original gh view reader for that PR instead.
 * Events are wake-only; no event payload substitutes for a live PR view here.
 */
export async function readDrainPrStateBatch({ repos, exec, env = process.env }) {
  const slugs = [...new Set(repos.filter(Boolean))];
  const result = new Map(slugs.map(repo => [repo, []]));
  let pending = slugs.map(repo => ({ repo, after: null }));
  try {
    if (slugs.some(repo => !/^[\w.-]+\/[\w.-]+$/.test(repo))) throw Error('invalid repo');
    while (pending.length) {
      const query = `query{${pending.map(({ repo, after }, i) => {
        const [owner, name] = repo.split('/');
        return `r${i}:repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){pullRequests(states:OPEN,first:100${after ? `,after:${JSON.stringify(after)}` : ''}){pageInfo{hasNextPage endCursor} nodes{${selection}}}}`;
      }).join('\n')}}`;
      const { stdout } = await exec('gh', ['api', 'graphql', '-f', `query=${query}`], {
        encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024, env: { ...env, GH_REPO: pending[0].repo },
      });
      const response = JSON.parse(stdout);
      if (response.errors?.length) throw Error('GraphQL batch failed');
      const next = [];
      for (const [i, { repo, after }] of pending.entries()) {
        const page = response.data?.[`r${i}`]?.pullRequests;
        if (!Array.isArray(page?.nodes) || typeof page.pageInfo?.hasNextPage !== 'boolean') throw Error('missing batch page');
        for (const n of page.nodes) {
          if (!n || !Number.isInteger(n.number) || !n.headRefOid || !n.updatedAt || typeof n.body !== 'string'
            || !Array.isArray(n.files?.nodes) || !Array.isArray(n.commits?.nodes)
            || n.files.pageInfo?.hasNextPage !== false || n.commits.pageInfo?.hasNextPage !== false
            || n.commits.nodes.some(c => !c?.commit || c.commit.authors?.pageInfo?.hasNextPage !== false
              || !Array.isArray(c.commit.authors?.nodes))) continue;
          result.get(repo).push({ number: n.number, updatedAt: n.updatedAt, headRefOid: n.headRefOid,
            body: n.body, files: n.files.nodes,
            commits: n.commits.nodes.map(({ commit: { authors, ...commit } }) => ({ ...commit,
              authors: authors.nodes.map(a => ({ email: a.email, id: a.user?.id ?? '', login: a.user?.login ?? '', name: a.name })) })) });
        }
        if (page.pageInfo.hasNextPage) {
          const cursor = page.pageInfo.endCursor;
          if (!cursor || typeof cursor !== 'string' || cursor === after) throw Error('missing batch cursor');
          next.push({ repo, after: cursor });
        }
      }
      pending = next;
    }
    return result;
  } catch { return new Map(); } // All callers retain their per-PR reads on any failure.
}

/** Match the live listing's identity before using any batched heavy fields. */
export function batchedDrainPr(batch, repo, row) {
  return batch.get(repo)?.find(n => n.number === row.number && n.headRefOid === row.headRefOid
    && n.updatedAt === row.updatedAt) ?? null;
}
