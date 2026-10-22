/** Pass-start PR view batching only. Merge and label-write revalidation stays live. */
import { cascadePolicy, platformPreference } from './policy-cascade.mjs';
import { readDeclaredSettings } from './settings-files.mjs';

const intIn = (lo, hi) => v => Number.isInteger(v) && v >= lo && v <= hi;
const envInt = raw => (raw != null && /^\d+$/.test(String(raw).trim()) ? Number(String(raw).trim()) : undefined);

/**
 * `batched` turns the pass-start read on/off. `pageSize` (PRs per GraphQL page) and `commitsPerPr` (commit nodes
 * per PR) size the query: GitHub prices it by the REQUESTED `first:` values, and the nested commit authors make
 * `pageSize × commitsPerPr` the dominant term (100 × 100 cost 102 points live, 2026-10-20). A PR whose files or
 * commits overflow those caps is left to its per-PR `gh pr view` read, so smaller caps never hide data.
 */
export function resolveDrainPrState({ env = process.env, file, platform, log } = {}) {
  const raw = env.WE_DRAIN_PR_STATE_BATCHED?.trim().toLowerCase();
  const batched = raw ? ({ true: true, false: false, on: true, off: false, 1: true, 0: false }[raw] ?? raw) : undefined;
  return cascadePolicy('drain.prState', (file ?? readDeclaredSettings().settings)?.drain?.prState, {
    standard: { batched: true, pageSize: 40, commitsPerPr: 50 }, platform: platform ?? platformPreference('drain', { env })?.prState,
    env, log,
    envValues: { batched, pageSize: envInt(env.WE_DRAIN_PR_STATE_PAGE_SIZE), commitsPerPr: envInt(env.WE_DRAIN_PR_STATE_COMMITS) },
    valid: { batched: v => typeof v === 'boolean', pageSize: intIn(1, 100), commitsPerPr: intIn(1, 100) },
  });
}

// Five authors bounds the nested GraphQL node cost; overflow takes the per-PR path.
const selection = commitsPerPr => `number updatedAt headRefOid body
  files(first:100){pageInfo{hasNextPage} nodes{path additions deletions changeType}}
  commits(first:${commitsPerPr}){pageInfo{hasNextPage} nodes{commit{oid authoredDate committedDate messageHeadline messageBody
    authors(first:5){pageInfo{hasNextPage} nodes{email name user{id login}}}}}}`;

/** Every page of ONE repository's open PRs. Throws on any failed, partial or malformed page. */
async function readRepo({ repo, exec, env, pageSize, commitsPerPr }) {
  const [owner, name] = repo.split('/');
  const rows = [];
  let after = null, pages = 0, overflow = 0;
  for (;;) {
    const query = `query{r0:repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){pullRequests(states:OPEN,first:${pageSize}${after ? `,after:${JSON.stringify(after)}` : ''}){pageInfo{hasNextPage endCursor} nodes{${selection(commitsPerPr)}}}}}`;
    // GH_REPO names this repository's owner, so the per-owner App shim authenticates as THAT owner's
    // installation. One query spanning owners carries one token and NOT_FOUNDs every other owner.
    let stdout;
    try {
      ({ stdout } = await exec('gh', ['api', 'graphql', '-f', `query=${query}`], {
        encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024, env: { ...env, GH_REPO: repo },
      }));
    } catch (e) {
      // gh exits 1 on a GraphQL `errors` reply; name its type instead of echoing the whole query back.
      let type = null;
      try { type = JSON.parse(String(e?.stdout || '')).errors?.[0]?.type || null; } catch { /* not a GraphQL reply */ }
      throw Error(type ? `GraphQL errors: ${String(type).slice(0, 80)}` : `gh failed: ${String(e?.stderr || e?.code || 'error').trim().split('\n').pop().slice(0, 100)}`);
    }
    pages++;
    const response = JSON.parse(stdout);
    if (response.errors?.length) throw Error(`GraphQL errors: ${String(response.errors[0]?.type || response.errors[0]?.message || 'unknown').slice(0, 80)}`);
    const page = response.data?.r0?.pullRequests;
    if (!Array.isArray(page?.nodes) || typeof page.pageInfo?.hasNextPage !== 'boolean') throw Error('missing batch page');
    for (const n of page.nodes) {
      if (!n || !Number.isInteger(n.number) || !n.headRefOid || !n.updatedAt || typeof n.body !== 'string'
        || !Array.isArray(n.files?.nodes) || !Array.isArray(n.commits?.nodes)
        || n.files.pageInfo?.hasNextPage !== false || n.commits.pageInfo?.hasNextPage !== false
        || n.commits.nodes.some(c => !c?.commit || c.commit.authors?.pageInfo?.hasNextPage !== false
          || !Array.isArray(c.commit.authors?.nodes))) { overflow++; continue; }
      rows.push({ number: n.number, updatedAt: n.updatedAt, headRefOid: n.headRefOid,
        body: n.body, files: n.files.nodes,
        commits: n.commits.nodes.map(({ commit: { authors, ...commit } }) => ({ ...commit,
          authors: authors.nodes.map(a => ({ email: a.email, id: a.user?.id ?? '', login: a.user?.login ?? '', name: a.name })) })) });
    }
    if (!page.pageInfo.hasNextPage) return { rows, pages, overflow };
    const cursor = page.pageInfo.endCursor;
    if (!cursor || typeof cursor !== 'string' || cursor === after) throw Error('missing batch cursor');
    after = cursor;
  }
}

/** One paged query per repository (each owner needs its own App installation token), run concurrently.
 * A repository whose pages fail in any way contributes NOTHING, so all of its PRs keep their per-PR reads;
 * the other repositories keep their batch. Nested connections that need more pages, and PRs absent from the
 * batch, also use the original gh view reader. Events are wake-only; no event payload substitutes for a live
 * PR view here. `report` (optional) receives one `{ repo, ok, rows, pages, overflow, error }` per repository.
 */
export async function readDrainPrStateBatch({ repos, exec, env = process.env, pageSize = 40, commitsPerPr = 50, report }) {
  const slugs = [...new Set(repos.filter(Boolean))];
  const result = new Map();
  await Promise.all(slugs.map(async repo => {
    let outcome;
    try {
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw Error('invalid repo');
      const { rows, pages, overflow } = await readRepo({ repo, exec, env, pageSize, commitsPerPr });
      result.set(repo, rows);
      outcome = { repo, ok: true, rows: rows.length, pages, overflow, error: null };
    } catch (e) {
      // All of this repository's callers retain their per-PR reads.
      outcome = { repo, ok: false, rows: 0, pages: 0, overflow: 0, error: String(e?.message || e).split('\n')[0].slice(0, 120) };
    }
    try { report?.(outcome); } catch { /* reporting never changes the batch */ }
  }));
  return result;
}

/** Match the live listing's identity before using any batched heavy fields. */
export function batchedDrainPr(batch, repo, row) {
  return batch.get(repo)?.find(n => n.number === row.number && n.headRefOid === row.headRefOid
    && n.updatedAt === row.updatedAt) ?? null;
}
