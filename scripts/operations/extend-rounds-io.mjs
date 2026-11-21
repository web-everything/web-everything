/** Live reader and verified comment writer for the operator's extend-rounds operation. */
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { countGrantedRoundExtensions } from '../conveyor/round-extension-mark.mjs';
import { OPERATOR_LOGINS } from '../lib/marker-authorship.mjs';
import { ROUND_EXTENSION_POST_EFFECT, planRoundExtension, validNonconvergenceDesignPath } from './extend-rounds.mjs';
import { realpathSync, statSync } from 'node:fs';
import { handoffHome } from '../lib/handoff-path.mjs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Re-run the red-team gate on this PR right after a proven grant. The gate runs only after a red-team pass otherwise,
 * so a break it parked at the round cap would stay parked although the operator just granted the round. The gate
 * decides under its own rules (the grant must cover the current round); this only asks it to look again.
 */
export function runRedTeamGateForPr({ repo, pr, root = REPO_ROOT, env = process.env }) {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'operations', 'red-team-gate-apply.mjs'), `--pr=${pr}`, `--repo=${repo}`],
    { cwd: root, env, encoding: 'utf8', timeout: 10 * 60 * 1000 });
  const last = String(r.stdout ?? '').trim().split('\n').pop() ?? '';
  try { return JSON.parse(last); } catch { return { status: 'error', reason: `red-team gate exit ${r.status}, no result` }; }
}

const gh = (args, throttle) => execFileSyncThrottled('gh', args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
  ...(throttle ? { throttle } : {}),
});

const isInside = (parent, target) => {
  const path = relative(parent, target);
  return path !== '' && !isAbsolute(path) && path.split(sep)[0] !== '..';
};

/** Establish regular-file evidence within the real designs directory and handoff root. */
export function readNonconvergenceDesign(path, { root = handoffHome() } = {}) {
  let exists = false;
  if (validNonconvergenceDesignPath(path)) {
    try {
      const realRoot = realpathSync(root);
      const designs = realpathSync(join(root, 'designs'));
      const target = realpathSync(join(root, path));
      exists = isInside(realRoot, designs) && isInside(designs, target)
        && statSync(target).isFile()
        && validNonconvergenceDesignPath(`designs/${basename(target)}`);
    } catch { /* Unreadable or missing designs cannot authorize an override. */ }
  }
  return { path, exists };
}

/** Prove that slurped GraphQL pages form a complete comment thread before judging any rounds. */
function assembleCommentHistory(pages) {
  const refuse = () => { throw new Error('round extension refused: incomplete or malformed comments history; operator must inspect the full thread and retry'); };
  if (!Array.isArray(pages) || pages.length === 0) refuse();
  const comments = [];
  const cursors = new Set();
  let total;
  for (const [index, page] of pages.entries()) {
    const connection = page?.data?.repository?.pullRequest?.comments;
    const info = connection?.pageInfo;
    if (page?.errors !== undefined && (!Array.isArray(page.errors) || page.errors.length > 0)) refuse();
    if (!Number.isSafeInteger(connection?.totalCount) || connection.totalCount < 0
      || !Array.isArray(connection.nodes) || typeof info?.hasNextPage !== 'boolean'
      || !(info.endCursor === null || (typeof info.endCursor === 'string' && info.endCursor.length > 0))
      || connection.nodes.some(c => typeof c?.body !== 'string' || typeof c?.createdAt !== 'string'
        || !Number.isFinite(Date.parse(c.createdAt)) || typeof c?.viewerDidAuthor !== 'boolean'
        || !(c.author === null || (typeof c.author?.login === 'string' && c.author.login.length > 0)))) refuse();
    if (index === 0) total = connection.totalCount;
    if (connection.totalCount !== total || info.hasNextPage !== (index < pages.length - 1)) refuse();
    if (info.hasNextPage) {
      if (!info.endCursor || cursors.has(info.endCursor) || connection.nodes.length === 0) refuse();
      cursors.add(info.endCursor);
    }
    comments.push(...connection.nodes);
  }
  if (comments.length !== total) refuse();
  return { comments, commentsTotal: total };
}

/** Preserve the array-only API for callers that do not need the verified connection total. */
export function assembleComments(pages) {
  return assembleCommentHistory(pages).comments;
}

export function readExtensionThread(repo, pr, { despiteDesign, gh: runGh = gh } = {}) {
  const [owner, name] = repo.split('/');
  const query = 'query($owner:String!,$name:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){comments(first:100,after:$endCursor){totalCount pageInfo{hasNextPage endCursor} nodes{author{login} body createdAt viewerDidAuthor}}}}}';
  const { comments, commentsTotal } = assembleCommentHistory(JSON.parse(runGh(['api', 'graphql', '--paginate', '--slurp',
    '-f', `query=${query}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${pr}`])));
  const thread = JSON.parse(runGh(['pr', 'view', String(pr), '--repo', repo, '--json', 'state,files,headRefOid']));
  return { ...thread, comments, commentsTotal, files: thread.files?.map((file) => file.path) ?? [],
    ...(validNonconvergenceDesignPath(despiteDesign)
      ? { despiteDesign: readNonconvergenceDesign(despiteDesign) } : {}) };
}

export function createExtendRoundsReader({ readThread = readExtensionThread, now = () => new Date().toISOString() } = {}) {
  return ({ repo, pr, despiteDesign }) => ({ ...readThread(repo, pr, { despiteDesign }), now: now() });
}

/**
 * The GitHub login the posting credential authenticates as — what will be recorded as the comment's author.
 * The throttle's personal-read route is switched off for this call: it sends READS (this one) under the operator's
 * stored token while the comment WRITE stays on the App token, so a routed read would name an identity that never posts.
 */
export const readViewerLogin = () => gh(['api', 'user', '--jq', '.login'], { personalRoute: false }).trim();

export function createExtendRoundsSinks({
  readThread = readExtensionThread,
  post = (repo, pr, body) => gh(['pr', 'comment', String(pr), '--repo', repo, '--body', body]),
  readViewerLogin: viewerLogin = readViewerLogin,
  regate = null,
} = {}) {
  return {
    [ROUND_EXTENSION_POST_EFFECT]: async ({ record, body }) => {
      const { repo, pr, by } = record;
      // The grant counts only when GitHub records the operator as the author, so refuse before posting under any
      // other credential (e.g. the automation's) rather than leave an inert, misleading grant on the PR.
      const viewer = String(await viewerLogin() ?? '').trim().toLowerCase();
      if (!OPERATOR_LOGINS.includes(viewer) || viewer !== record.actor) {
        throw new Error(`extend-rounds must run under the operator's own GitHub credential (acting as "${record.actor}"); this one is "${viewer || 'unknown'}"`);
      }
      const before = await readThread(repo, pr, { despiteDesign: record.despiteDesign });
      const validated = planRoundExtension({ ...before, now: record.at }, record);
      if (validated.body !== body) throw new Error('round extension body does not match its validated record');
      const count = countGrantedRoundExtensions(before.comments, { repo, pr });
      await post(repo, pr, body);
      const after = await readThread(repo, pr, { despiteDesign: record.despiteDesign });
      if (countGrantedRoundExtensions(after.comments, { repo, pr }) !== count + by
        || !after.comments.some((c) => c.body === body && countGrantedRoundExtensions([c], { repo, pr }) === by)) {
        throw new Error('could not prove the posted round extension increased the trusted grant count');
      }
      // The grant is posted and proven; a gate that cannot re-run is reported, never an undone grant.
      let redTeamGate = null;
      if (typeof regate === 'function') {
        try { redTeamGate = await regate({ repo, pr }); } catch (e) { redTeamGate = { status: 'error', reason: String(e?.message ?? e).slice(0, 300) }; }
      }
      return { granted: by, total: count + by, ...(redTeamGate ? { redTeamGate } : {}) };
    },
  };
}
