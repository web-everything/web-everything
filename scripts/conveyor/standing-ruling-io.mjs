/**
 * @file scripts/conveyor/standing-ruling-io.mjs
 * @description Read-time verification for standing-ruling round grants (`standing-ruling-mark.mjs`,
 *   `round-extension-mark.mjs`). For one PR it reads, fresh on every call (no cross-call cache, so a closed or
 *   edited ruling stops counting at the very next read):
 *     - the operator's ruling issue (author, last editor, state);
 *     - which comments on the PR GitHub shows as never edited;
 *     - for each head a grant cites: that the commit belongs to THIS PR, and that its net diff vs current main is
 *       entirely cards (fail closed).
 *   The result is the `standingRuling` scope the pure grant reader needs; without it no automation-posted grant
 *   counts. Reads only, on the daemon's App identity (personal read routing off). Diagnostics are redacted.
 */
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { readHumanSurfaceNetFiles } from '../lib/human-surface-net-diff.mjs';
import { OPERATOR_LOGINS } from '../lib/marker-authorship.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { isCardOnlyNetDiff } from './auto-round-grant.mjs';
import { citedGrantHeads, pickStandingRuling } from './standing-ruling-mark.mjs';
import { readCompletePrCommentEditHistory } from './pr-comments-complete.mjs';

const slugOf = (repo) => CONSTELLATION_REPOS[repo]?.slug ?? repo;
/** Credential-shaped strings never reach a log or a reason. */
export function redact(text) {
  return String(text).replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})/g, '[redacted]');
}
const firstLine = (e) => redact(String(e?.stderr || e?.message || e).trim().split('\n')[0]).slice(0, 300);
const quietLog = (line) => { try { process.stderr.write(`${redact(line)}\n`); } catch { /* never fails a read */ } };

/** App-identity gh read: personal read routing off, so the verdict never rests on the operator's login. */
export const ghAppRead = (args) => execFileSyncThrottled('gh', args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, maxBuffer: 64 * 1024 * 1024, throttle: { personalRoute: false },
});

const ISSUES = `query($owner:String!,$name:String!,$by:String!){repository(owner:$owner,name:$name){issues(first:30,filterBy:{createdBy:$by,states:OPEN},orderBy:{field:CREATED_AT,direction:DESC}){nodes{number state body lastEditedAt author{login} editor{login}}}}}`;

/** IO: every OPEN issue each operator login created in `repo` (the ruling candidates). */
export function readOperatorIssues(repo, { gh = ghAppRead } = {}) {
  const [owner, name] = repo.split('/');
  return OPERATOR_LOGINS.flatMap((login) => {
    const raw = gh(['api', 'graphql', '-f', `query=${ISSUES}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `by=${login}`]);
    return JSON.parse(String(raw))?.data?.repository?.issues?.nodes ?? [];
  });
}

/** IO: the verified standing ruling of `repo`, or null (none, revoked, edited by a non-operator, unreadable). */
export function readStandingRuling(repo, { readIssues = readOperatorIssues, log = quietLog } = {}) {
  const slug = slugOf(repo);
  try { return pickStandingRuling(readIssues(slug), { repo: slug }); }
  catch (e) { log(`standing-ruling: read failed for ${slug}: ${firstLine(e)}`); return null; }
}

/** IO: ids across the complete PR thread that GitHub shows as never edited. */
export function readUneditedCommentIds({ repo, number }, { gh = ghAppRead, readEdits = readCompletePrCommentEditHistory } = {}) {
  const nodes = readEdits(number, { repo: slugOf(repo), exec: (_file, args) => gh(args) });
  return nodes.filter((c) => typeof c?.id === 'string' && c.lastEditedAt === null).map((c) => c.id);
}

/** IO: does GitHub associate commit `head` with PR `number`? */
export function headBelongsToPr({ repo, number, head }, { gh = ghAppRead } = {}) {
  const raw = gh(['api', `repos/${slugOf(repo)}/commits/${head}/pulls`, '--jq', '[.[].number]']);
  const numbers = JSON.parse(String(raw));
  return Array.isArray(numbers) && numbers.includes(Number(number));
}

/** IO: is `head` a commit of this PR whose net diff vs current main is entirely cards? false on any doubt. */
export function headIsCardOnly({ repo, number, head }, { readNet = readHumanSurfaceNetFiles, belongs = headBelongsToPr } = {}) {
  try {
    if (!belongs({ repo, number, head })) return false;
    const net = readNet({ repo: slugOf(repo), number, headRefOid: head }, { log: quietLog });
    return !!net?.ok && isCardOnlyNetDiff(net.files);
  } catch { return false; }
}

/**
 * IO: the `standingRuling` scope for one PR's grant reader, or null when the thread cites no ruling grant (no
 * reads made) or no valid ruling exists. Every cited head is re-judged; edited comments are excluded.
 * @param {{repo:string, pr:{number:number, comments:Array}, ruling?:object|null, extraHeads?:Record<string,boolean>}} o
 */
export function standingRulingScope({ repo, pr, ruling: given }, {
  readRuling = readStandingRuling, cardOnly = headIsCardOnly, unedited = readUneditedCommentIds,
} = {}) {
  const heads = citedGrantHeads(pr?.comments);
  if (!heads.length) return null;
  const ruling = given === undefined ? readRuling(repo) : given;
  if (!ruling) return null;
  let uneditedComments = [];
  try { uneditedComments = unedited({ repo, number: pr.number }); } catch { uneditedComments = []; }
  const cardOnlyHeads = Object.fromEntries(heads.map((head) => [head, cardOnly({ repo, number: pr.number, head }) === true]));
  return { ...ruling, cardOnlyHeads, uneditedComments };
}

/** Reconcile enrich step: one ruling read per call, a scope on every PR whose thread cites a grant. Never throws. */
export function enrichPrsWithStandingRulingGrants(prs, { repo, scope = standingRulingScope, readRuling = readStandingRuling } = {}) {
  if (!Array.isArray(prs)) return prs;
  let ruling;
  return prs.map((pr) => {
    try {
      if (!citedGrantHeads(pr?.comments).length) return pr;
      if (ruling === undefined) ruling = readRuling(repo);
      const standingRuling = scope({ repo, pr, ruling });
      return standingRuling ? { ...pr, standingRuling } : pr;
    } catch { return pr; }
  });
}
