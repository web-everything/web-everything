/** Read queries include their own rateLimit cost; gh-throttle captures it before stdout projection. */
import { runGhSync } from './gh-throttle.mjs';
import { execDrainAsync } from './drain-gh-async.mjs';

const OID = /^[a-f0-9]{40}$/;
const incomplete = reason => ({ commits: [], headOid: null, baseOid: null, complete: false, reason });

/** Explicit, bounded cursor requests make completeness observable rather than trusting gh's page aggregation.
 * Unknown or changed identities, partial pages and exhausted bounds require another pass/operator inspection.
 */
function* commitRequests(repo, number, { headRefOid, baseRefOid } = {}) {
  if (!OID.test(headRefOid ?? '') || !OID.test(baseRefOid ?? '')) return incomplete('missing-expected-oids');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isSafeInteger(number) || number < 1) return incomplete('invalid-pr');
  const [owner, name] = repo.split('/');
  const query = `query($owner:String!,$name:String!,$number:Int!,$endCursor:String){
    rateLimit { cost }
    repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid baseRefOid commits(first:100,after:$endCursor){
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes { commit { oid messageHeadline messageBody authors(first:100){nodes{name email}} } }
    }}}
  }`;
  const commits = [], seen = new Set(), cursors = new Set();
  let after = null, total = null, bytes = 0;
  // 1,000 pages / 100,000 commits / 64 MiB total. A larger history is unknown, never AI by truncation.
  for (let pageNumber = 0; pageNumber < 1000; pageNumber++) {
    const raw = yield ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`,
      '-F', `number=${number}`, ...(after === null ? [] : ['-f', `endCursor=${after}`])];
    bytes += Buffer.byteLength(String(raw));
    if (bytes > 64 * 1024 * 1024) return incomplete('commits-output-limit: operator inspection required');
    let page;
    try { page = JSON.parse(String(raw)); } catch { return incomplete('malformed-commits-page'); }
    const pr = page?.data?.repository?.pullRequest, connection = pr?.commits, info = connection?.pageInfo;
    if (page?.errors?.length || pr?.headRefOid !== headRefOid || pr?.baseRefOid !== baseRefOid) return incomplete('commits-identity-or-query-failure');
    if (!Array.isArray(connection?.nodes) || connection.nodes.length > 100 || !Number.isSafeInteger(connection.totalCount)
      || connection.totalCount < 0 || connection.totalCount > 100_000 || typeof info?.hasNextPage !== 'boolean') return incomplete('invalid-commits-page');
    if (total !== null && total !== connection.totalCount) return incomplete('commits-total-changed');
    total = connection.totalCount;
    for (const node of connection.nodes) {
      const c = node?.commit;
      if (!OID.test(c?.oid ?? '') || seen.has(c.oid) || !Array.isArray(c.authors?.nodes)
        || typeof c.messageHeadline !== 'string' || typeof c.messageBody !== 'string') return incomplete('invalid-or-duplicate-commit');
      seen.add(c.oid); commits.push({ ...c, authors: c.authors.nodes });
    }
    if (commits.length > total) return incomplete('commits-count-overflow');
    if (!info.hasNextPage) return commits.length === total
      ? { commits, headOid: headRefOid, baseOid: baseRefOid, complete: true }
      : incomplete('commits-missing-page');
    if (!connection.nodes.length || commits.length >= total || typeof info.endCursor !== 'string'
      || !info.endCursor || cursors.has(info.endCursor)) return incomplete('commits-cursor-chain');
    after = info.endCursor; cursors.add(after);
  }
  return incomplete('commits-page-limit: operator inspection required');
}
const commitsOptions = () => ({ encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
  killSignal: 'SIGKILL', throttle: { op: 'pr view commits (paged)' } });

export function meteredPrCommits(repo, number, { exec = runGhSync, ...expected } = {}) {
  const requests = commitRequests(repo, number, expected);
  let next = requests.next();
  while (!next.done) next = requests.next(exec(next.value, commitsOptions()));
  return next.value;
}

/** Same request/parser contract for the drain's asynchronous, throttled executor. */
const readCommitsAsync = async (args, opts) => (await execDrainAsync('gh', args, opts)).stdout;
export async function meteredPrCommitsAsync(repo, number, { exec = readCommitsAsync, ...expected } = {}) {
  const requests = commitRequests(repo, number, expected);
  let next = requests.next();
  while (!next.done) next = requests.next(await exec(next.value, commitsOptions()));
  return next.value;
}

/** The already-done search as `{args, opts}` — shared by the sync and async callers so the async one can await its own executor. */
export function alreadyDoneRequest(repo, key, opts = {}) {
  const query = `query($search:String!){
    rateLimit { cost }
    search(query:$search,type:ISSUE,first:5){nodes{... on PullRequest{
      number title url mergedAt headRefName body
      files(first:100){nodes{path}}
    }}}
  }`;
  return {
    args: ['api', 'graphql', '-f', `query=${query}`, '-f', `search=repo:${repo} is:pr is:merged ${key} in:title`, '--jq', '[.data.search.nodes[] | .files = .files.nodes]'],
    opts: { encoding: 'utf8', ...opts, throttle: { op: 'pr list (already-done)' } },
  };
}

/** `opts` (timeout, killSignal, maxBuffer, stdio) is forwarded to the exec so the CALL SITE owns its subprocess bounds (#3460). */
export function meteredAlreadyDone(repo, key, { exec = runGhSync, opts = {} } = {}) {
  const req = alreadyDoneRequest(repo, key, opts);
  return JSON.parse(String(exec(req.args, req.opts)));
}
