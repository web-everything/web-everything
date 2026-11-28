/** Read queries include their own rateLimit cost; gh-throttle captures it before stdout projection. */
import { runGhSync } from './gh-throttle.mjs';
import { execDrainAsync } from './drain-gh-async.mjs';

const COMMITS_TIMEOUT_MS = 120_000;
const COMMITS_MAX_BUFFER = 64 * 1024 * 1024;
const COMMITS_LIMIT = 100_000;
const OID_RE = /^[0-9a-f]{40}$/;
const validOid = oid => typeof oid === 'string' && OID_RE.test(oid);
const degraded = reason => ({ commits: [], headOid: null, baseOid: null, complete: false, reason });

function commitsRequest(repo, number) {
  const [owner, name] = repo.split('/');
  const query = `query($owner:String!,$name:String!,$number:Int!,$endCursor:String){
    rateLimit { cost }
    repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid baseRefOid commits(first:100,after:$endCursor){
      totalCount pageInfo { hasNextPage endCursor }
      nodes { commit { oid messageHeadline messageBody authors(first:100){nodes{name email}} } }
    }}}
  }`;
  // gh rejects --slurp with --jq. One bounded aggregate read, validated before projecting any evidence.
  return { args: ['api', 'graphql', '--paginate', '--slurp', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`],
    opts: { encoding: 'utf8', timeout: COMMITS_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: COMMITS_MAX_BUFFER,
      throttle: { op: 'pr view commits (paged)' } } };
}

function parseCommits(raw, { headRefOid, baseRefOid }) {
  if (Buffer.byteLength(String(raw)) > COMMITS_MAX_BUFFER) return degraded('max-buffer');
  let pages;
  try { pages = JSON.parse(String(raw)); } catch { return degraded('malformed-json'); }
  if (!Array.isArray(pages) || !pages.length) return degraded('invalid-pages');
  const commits = [], seen = new Set(), cursors = new Set();
  let total = null, terminal = false;
  for (const page of pages) {
    if (terminal) return degraded('page-after-terminal');
    if (page?.errors !== undefined && (!Array.isArray(page.errors) || page.errors.length)) return degraded('graphql-errors');
    const pr = page?.data?.repository?.pullRequest, c = pr?.commits;
    if (!validOid(pr?.headRefOid) || !validOid(pr?.baseRefOid)) return degraded('invalid-page-identity');
    if (pr.headRefOid !== headRefOid) return degraded('head-oid-mismatch');
    if (pr.baseRefOid !== baseRefOid) return degraded('base-oid-mismatch');
    if (!Number.isSafeInteger(c?.totalCount) || c.totalCount < 0) return degraded('invalid-total-count');
    if (c.totalCount > COMMITS_LIMIT) return degraded('commit-limit');
    if (total !== null && total !== c.totalCount) return degraded('inconsistent-total-count');
    total = c.totalCount;
    const info = c.pageInfo;
    if (typeof info?.hasNextPage !== 'boolean' || !(info.endCursor === null || typeof info.endCursor === 'string')
      || (info.hasNextPage && !info.endCursor)) return degraded('invalid-page-info');
    if (info.endCursor !== null) {
      if (cursors.has(info.endCursor)) return degraded('repeated-cursor');
      cursors.add(info.endCursor);
    }
    if (!Array.isArray(c.nodes) || c.nodes.length > 100 || commits.length + c.nodes.length > total
      || (info.hasNextPage && (!c.nodes.length || commits.length + c.nodes.length >= total))) return degraded('invalid-page-count');
    for (const node of c.nodes) {
      const commit = node?.commit;
      if (!validOid(commit?.oid)) return degraded('invalid-commit-oid');
      if (seen.has(commit.oid)) return degraded('duplicate-commit-oid');
      if (!Array.isArray(commit.authors?.nodes) || !commit.authors.nodes.every(a => a && typeof a.name === 'string' && typeof a.email === 'string')) return degraded('invalid-commit-authors');
      seen.add(commit.oid);
      commits.push({ ...commit, authors: commit.authors.nodes });
    }
    if (commits.length > COMMITS_LIMIT) return degraded('commit-limit');
    terminal = !info.hasNextPage;
    if (terminal && commits.length !== total) return degraded('premature-terminal-page');
  }
  if (!terminal) return degraded('missing-terminal-page');
  return { commits, headOid: headRefOid, baseOid: baseRefOid, complete: true };
}

function readFailure(error) {
  const detail = `${error?.code ?? ''} ${error?.message ?? ''} ${error?.stderr ?? ''}`;
  return degraded(/ETIMEDOUT|timed?\s*out|timeout/i.test(detail) ? 'timeout'
    : /ENOBUFS|MAXBUFFER|max.?buffer/i.test(detail) ? 'max-buffer' : 'read-failed');
}

/** Complete authorship evidence only; unknown identities and every partial read refuse with a named reason. */
export function meteredPrCommits(repo, number, { exec = runGhSync, headRefOid, baseRefOid } = {}) {
  if (!validOid(headRefOid) || !validOid(baseRefOid)) return degraded('invalid-expected-identity');
  const request = commitsRequest(repo, number);
  try { return parseCommits(exec(request.args, request.opts), { headRefOid, baseRefOid }); }
  catch (error) { return readFailure(error); }
}

const readCommitsAsync = async (args, opts) => (await execDrainAsync('gh', args, opts)).stdout;

/** Same request and parser for the drain's asynchronous throttle worker. */
export async function meteredPrCommitsAsync(repo, number, { exec = readCommitsAsync, headRefOid, baseRefOid } = {}) {
  if (!validOid(headRefOid) || !validOid(baseRefOid)) return degraded('invalid-expected-identity');
  const request = commitsRequest(repo, number);
  try { return parseCommits(await exec(request.args, request.opts), { headRefOid, baseRefOid }); }
  catch (error) { return readFailure(error); }
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
