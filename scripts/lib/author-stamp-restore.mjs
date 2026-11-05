/** Recover author stamps only from complete, agreeing GitHub edit-history evidence. */
import { execFileSyncThrottled } from './gh-throttle.mjs';
import { readAuthorActorStamps, hasStampLostMarker } from './review-independence.mjs';
import { writeLineSync } from './write-all-sync.mjs';

const IO_OPTIONS = { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 };
const refusal = (reason) => ({ action: 'refuse', reason });
const safe = (value) => String(value).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ');

/** One bounded request. Truncation is not agreement: operators must investigate the full history. */
export function readAuthorStampEdits(pr, { repo, exec = execFileSyncThrottled } = {}) {
  const parts = typeof repo === 'string' ? repo.split('/') : [];
  if (parts.length !== 2 || parts.some((p) => !p.trim()) || !/^[1-9]\d*$/.test(String(pr))) {
    throw new Error('invalid repository or PR number');
  }
  const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){userContentEdits(first:100){totalCount pageInfo{hasNextPage} nodes{createdAt editor{__typename login} diff}}}}}`;
  const data = JSON.parse(exec('gh', ['api', 'graphql', '-f', `query=${query}`,
    '-f', `owner=${parts[0]}`, '-f', `name=${parts[1]}`, '-F', `number=${pr}`], IO_OPTIONS));
  const connection = data?.data?.repository?.pullRequest?.userContentEdits;
  if (data.errors != null || !Array.isArray(connection?.nodes)
    || connection.pageInfo?.hasNextPage !== false
    || !Number.isInteger(connection.totalCount) || connection.totalCount !== connection.nodes.length
    || connection.nodes.length > 100) {
    throw new Error('unreadable or incomplete edit history; inspect the complete GitHub history before retrying');
  }
  return connection.nodes;
}

export function planStampRestore({ state, body, authorLogin, edits } = {}) {
  if (typeof body !== 'string') return refusal('unreadable live body');
  if (readAuthorActorStamps(body).length || hasStampLostMarker(body)) {
    return { action: 'skip', reason: 'live body already carries a stamp or stamp-lost marker' };
  }
  if (body.includes('authored-by-actor:')) return refusal('malformed live stamp; inspect the live body');
  if (state === 'CLOSED' || state === 'MERGED') return { action: 'skip', reason: 'PR is not open' };
  if (state !== 'OPEN') return refusal('unreadable PR state');
  if (typeof authorLogin !== 'string' || !authorLogin.trim()) return refusal('missing PR author login');
  // gh PR bot authors carry app/; GraphQL preserves the identity kind separately.
  const authorType = /^app\//i.test(authorLogin) ? 'Bot' : 'User';
  const author = authorLogin.toLowerCase().replace(/^app\//, '');
  if (!author) return refusal('missing PR author login');
  if (!Array.isArray(edits)) return refusal('unreadable edit history');
  if (edits.length > 100) return refusal('history exceeds the snapshot bound; inspect complete GitHub history');
  const ids = new Set();
  let oldest;
  let oldestMarker;
  for (const edit of edits) {
    if (typeof edit?.diff !== 'string' || !['Bot', 'User'].includes(edit.editor?.__typename)
      || typeof edit.editor?.login !== 'string'
      || !edit.editor.login.trim() || typeof edit.createdAt !== 'string' || !Number.isFinite(Date.parse(edit.createdAt))) {
      return refusal('unreadable edit snapshot or editor provenance; inspect complete GitHub history manually');
    }
    const markers = edit.diff.match(/<!--\s*authored-by-actor:[\s\S]*?-->/g) ?? [];
    // Accept only unambiguous plain bodies: delta text cannot prove marker authorship.
    // Any ambiguous snapshot invalidates the entire history, even when ids agree.
    if (/^@@ .* @@/m.test(edit.diff) || /^[ \t]*[+-][^\r\n]*authored-by-actor:/m.test(edit.diff)) {
      return refusal('unsupported delta edit snapshot; inspect complete GitHub history manually');
    }
    if (/<\/?[a-z][^>]*>/i.test(edit.diff)) {
      return refusal('unsupported HTML edit snapshot; inspect complete GitHub history manually');
    }
    if (edit.diff.replace(/<!--\s*authored-by-actor:[\s\S]*?-->/g, '').includes('authored-by-actor:')) {
      return refusal('malformed historical stamp');
    }
    // GitHub lists newest first for equal timestamps: the later position is older.
    if (!oldest || Date.parse(edit.createdAt) <= Date.parse(oldest.createdAt)) {
      oldest = edit;
      oldestMarker = markers[0];
    }
    for (const verbatim of markers) {
      const found = readAuthorActorStamps(verbatim);
      if (found.length !== 1 || !found[0]) return refusal('malformed historical stamp');
      ids.add(found[0]);
    }
  }
  if (ids.size !== 1) return refusal('history has no stamp or conflicting stamp ids; inspect GitHub history');
  if (!oldestMarker || oldest.editor.__typename !== authorType || oldest.editor.login.toLowerCase() !== author) {
    return refusal('no evidence the PR author supplied the stamp in the oldest snapshot; inspect GitHub history');
  }
  return { action: 'restore', reason: 'all historical stamps agree with the oldest author-edited snapshot',
    id: [...ids][0], source: oldest, marker: oldestMarker, body: `${body}\n\n${oldestMarker}\n` };
}

export function restoreAuthorStamp({ pr, repo, dryRun = false,
  exec = execFileSyncThrottled,
  readPr = (number) => JSON.parse(exec('gh', ['pr', 'view', String(number), '--repo', repo,
    '--json', 'state,body,author'], IO_OPTIONS)),
  readEdits = (number) => readAuthorStampEdits(number, { repo, exec }),
  writeBody = (number, body) => exec('gh', ['pr', 'edit', String(number), '--repo', repo, '--body-file', '-'],
    { ...IO_OPTIONS, input: body, env: { ...process.env, PR_BODY_STAMP_OK: '1' } }),
  log = (line) => writeLineSync(2, line),
} = {}) {
  try {
    const live = readPr(pr);
    const input = { state: live?.state, body: live?.body, authorLogin: live?.author?.login };
    const initial = planStampRestore(input);
    if (initial.action === 'skip' || initial.reason !== 'unreadable edit history') return initial;
    const plan = planStampRestore({ ...input, edits: readEdits(pr) });
    if (plan.action !== 'restore' || dryRun) return plan;
    const latest = readPr(pr);
    if (latest?.body !== live.body || latest?.state !== 'OPEN'
      || latest?.author?.login !== live.author.login) return refusal('live PR changed before write; retry from fresh evidence');
    writeBody(pr, plan.body);
    log(safe(`author-stamp-restore: #${pr} restored stamp ${plan.id} from edit ${plan.source.createdAt} by ${plan.source.editor.login}`));
    return plan;
  } catch (e) {
    return refusal(`restore failed: ${safe(e?.message ?? e)}; retry after evidence is readable`);
  }
}

const refusedUntil = new Map();
const RETRY_MS = 5 * 60_000;

export function sweepAuthorStamps({ repo, exec = execFileSyncThrottled,
  listPrs = () => JSON.parse(exec('gh', ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100',
    '--json', 'number,body,author'], IO_OPTIONS)), now = Date.now, ...io } = {}) {
  const time = now();
  for (const [key, entry] of refusedUntil) if (entry.until <= time) refusedUntil.delete(key);
  const prs = listPrs({ repo });
  if (!Array.isArray(prs) || prs.length >= 100) {
    throw new Error('unreadable or capped PR listing; narrow the repository listing or inspect remaining PRs manually');
  }
  return prs.map((pr) => {
    const key = JSON.stringify([repo, pr?.number, pr?.body, pr?.author?.login]);
    let result;
    if (!Number.isInteger(pr?.number) || pr.number <= 0) result = refusal('invalid listed PR number');
    else if (typeof pr.body !== 'string' || typeof pr.author?.login !== 'string' || !pr.author.login.trim()) {
      result = refusal('unreadable listed body or author');
    }
    else if (typeof pr.body === 'string' && (readAuthorActorStamps(pr.body).length || hasStampLostMarker(pr.body))) {
      result = { action: 'skip', reason: 'listed body already stamped or stamp-lost' };
    } else result = refusedUntil.get(key)?.result ?? restoreAuthorStamp({ ...io, repo, exec, pr: pr.number });
    if (result.action === 'refuse') {
      if (refusedUntil.size >= 1000) refusedUntil.delete(refusedUntil.keys().next().value);
      refusedUntil.set(key, { result, until: refusedUntil.get(key)?.until ?? time + RETRY_MS });
    }
    return { num: pr?.number, ...result, detail: result };
  });
}
