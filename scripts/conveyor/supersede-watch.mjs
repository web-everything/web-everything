/**
 * @file scripts/conveyor/supersede-watch.mjs — card xiqtf7w. The IO shell around `supersede-rule.mjs`.
 *
 * Per repo, per tick of the fix daemon (`reconcile-fix-dispatch-daemon.mjs#runTickAllRepos`, BEFORE its fix and
 * ci-heal halves): read the PRs merged in the last `lookbackDays` (with bodies) and the open PR numbers, read the
 * comments of only the open PRs a merged PR names in a `Supersedes` line, plan with `planSupersedeHolds`, and for each
 * hold post the terminal stand-down through `stand-down.mjs` (`--reason=superseded`, which also adds the
 * `review-status:stood-down` and `superseded` labels). It never closes a PR: that is an operator decision.
 *
 * Setting off (`supersede-settings.json` / `WE_SUPERSEDE_HOLD`) = no read, no write. Every read is bounded; a failed
 * list/planning failure blocks dispatch; a body-edit failure skips only its PR. Apply failures are reported per hold.
 * Usage as a one-off: `node supersede-watch.mjs
 * [--repo=<owner/name>] [--apply]` (dry run without `--apply`).
 */
import { execFileSyncThrottled as execFileSync } from '../lib/gh-throttle.mjs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { isTrustedSupersedeAuthor, parseSupersedes, planSupersedeHolds, resolveSupersedeSettings, supersedeCandidates } from './supersede-rule.mjs';
import { supersedeHoldsOn } from './stand-down.mjs';
import { readCompletePrComments } from './pr-comments-complete.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STAND_DOWN_CLI = join(HERE, 'stand-down.mjs');
export const SUPERSEDE_WATCH_ACTOR = 'supersede-watch (card xiqtf7w)';
const PAGE_SIZE = 100;
const MAX_LIST_PAGES = 100;

const slugOf = (repo) => CONSTELLATION_REPOS[repo]?.slug ?? repo;
const ghJson = (args, exec) => JSON.parse(String(exec('gh', args, {
  stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024,
}) || 'null'));

/** Count brackets and unique identities prove completeness despite mutable REST update ordering.
 * No short/old page alone establishes coverage. Any discrepancy requires an operator retry.
 */
function readPullPages({ repo, state, exec, since, requireComplete = false }) {
  const incomplete = (why) => new Error(`incomplete ${state} PR list in ${slugOf(repo)}: ${why}; operator must inspect the full list and retry next tick`);
  const [owner, name] = slugOf(repo).split('/');
  const readCount = () => {
    const out = ghJson(['api', 'graphql', '-f',
      'query=query($o:String!,$n:String!,$s:[PullRequestState!]!){repository(owner:$o,name:$n){pullRequests(states:$s){totalCount}}}',
      '-f', `o=${owner}`, '-f', `n=${name}`, '-f', `s[]=${state === 'open' ? 'OPEN' : 'CLOSED'}`,
      ...(state === 'closed' ? ['-f', 's[]=MERGED'] : [])], exec);
    const count = out?.data?.repository?.pullRequests?.totalCount;
    if (out?.errors?.length || !Number.isSafeInteger(count) || count < 0) throw incomplete('unreadable count proof');
    return count;
  };
  const expected = requireComplete ? readCount() : null;
  if (expected >= MAX_LIST_PAGES * PAGE_SIZE) throw new Error(`PR list page cap reached in ${slugOf(repo)}; operator must narrow the inventory or inspect the full list before dispatch; retry next tick`);
  const rows = [];
  const ids = new Set();
  for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
    const batch = ghJson(['api', `repos/${slugOf(repo)}/pulls?state=${state}&sort=updated&direction=desc&per_page=${PAGE_SIZE}&page=${page}`], exec);
    if (!Array.isArray(batch) || batch.length > PAGE_SIZE || batch.some(p => !Number.isSafeInteger(p?.number) || p.number < 1
      || (state === 'closed' && (!Number.isFinite(Date.parse(p.updated_at)) || (p.merged_at !== null && (
        !Number.isFinite(Date.parse(p.merged_at)) || (p.body !== null && typeof p.body !== 'string')
        || typeof p.user?.login !== 'string' || !p.user.login.trim())))))) {
      throw new Error(`unreadable ${state} PR list in ${slugOf(repo)}; operator must inspect evidence and retry next tick`);
    }
    for (const row of batch) {
      if (requireComplete && ids.has(row.number)) throw incomplete(`duplicate #${row.number}; ${ids.size} unique of claimed ${expected}`);
      ids.add(row.number);
      rows.push(row);
    }
    if (batch.length < PAGE_SIZE || (!requireComplete && since !== undefined && batch.every(p => Date.parse(p.updated_at) < since))) {
      if (requireComplete && (ids.size !== expected || readCount() !== expected)) throw incomplete(`${ids.size} unique of claimed ${expected}, or count changed`);
      return rows;
    }
  }
  throw new Error(`PR list page cap reached in ${slugOf(repo)}; operator must narrow the inventory or inspect the full list before dispatch; retry next tick`);
}

/** Low-level merged list, normalized to the planner shape. The daemon requires count proof via requireComplete. */
export function defaultReadMergedPrs({ repo, lookbackDays, now = Date.now(), exec = execFileSync, requireComplete = false }) {
  const since = now - lookbackDays * 86_400_000;
  return readPullPages({ repo, state: 'closed', exec, since, requireComplete })
    .filter(p => Date.parse(p.merged_at) >= since)
    .map(p => ({ number: p.number, body: p.body, state: 'MERGED', mergedAt: p.merged_at, author: p.user }));
}

/**
 * One GraphQL response binds body, stable identity, merged state, head and edit version.
 * Read only for merged PRs carrying relevant markers. The caller validates the complete snapshot.
 */
export function defaultReadBodyEdit({ repo, pr, exec = execFileSync }) {
  const [owner, name] = slugOf(repo).split('/');
  const out = ghJson(['api', 'graphql', '-f', 'query=query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){id number body state author{login} mergedAt updatedAt headRefOid lastEditedAt editor{login}}}}',
    '-f', `o=${owner}`, '-f', `n=${name}`, '-F', `p=${Number(pr)}`], exec);
  if (out?.errors?.length) throw new Error(`GraphQL body-edit read failed for #${pr}`);
  const node = out?.data?.repository?.pullRequest;
  if (!node) throw new Error(`no pull request #${pr} in ${slugOf(repo)}`);
  if (node.lastEditedAt === undefined || node.editor === undefined) throw new Error(`incomplete body-edit fields for #${pr}`);
  return node;
}

/**
 * Put the body-edit facts on each merged PR whose marker could matter (trusted author, at least one target that is
 * still OPEN, so a read costs a call only when a hold is actually possible). A failed read marks that one PR
 * `bodyEditUnknown` (the rule then ignores it: a missed hold costs one fixer run, a false one stops an unrelated PR);
 * it never throws and never blocks the others. Returns `{ rows, failures }` so a persistent failure (no GraphQL access,
 * a rate limit) is reported instead of silently switching every hold off.
 */
const timestamp = (value, now) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms <= now && new Date(ms).toISOString() === value.replace(/Z$/, value.includes('.') ? 'Z' : '.000Z');
};
// Compare API spellings only after the author trust gate; normalization grants no authority.
const authorLogin = p => {
  const login = p?.author?.login;
  return typeof login === 'string' ? login.replace(/^app\//, '').replace(/\[bot\]$/i, '').toLowerCase() : '';
};
const snapshotVersion = (p) => JSON.stringify([p.id, p.number, p.body, p.state, authorLogin(p),
  p.mergedAt, p.updatedAt, p.headRefOid, p.lastEditedAt, p.editor?.login ?? null]);
function validateSnapshot(p, listed, now) {
  if (!p || p.number !== listed.number || typeof p.id !== 'string' || !p.id
    || p.state !== 'MERGED' || (p.body !== null && typeof p.body !== 'string')
    || !isTrustedSupersedeAuthor(p) || authorLogin(p) !== authorLogin(listed) || !/^[a-f0-9]{40}$/i.test(p.headRefOid ?? '')
    || !timestamp(p.mergedAt, now) || !timestamp(p.updatedAt, now) || Date.parse(p.updatedAt) < Date.parse(p.mergedAt)
    || !(p.lastEditedAt === null ? p.editor === null : timestamp(p.lastEditedAt, now)
      && Date.parse(p.lastEditedAt) <= Date.parse(p.updatedAt) && typeof p.editor?.login === 'string' && !!p.editor.login.trim())
    || ['body', 'state', 'mergedAt', 'id', 'updatedAt', 'headRefOid'].some(k => listed[k] !== undefined && p[k] !== listed[k])) {
    throw new Error(`unreadable or changed merged PR #${listed.number} snapshot; operator must inspect evidence and retry next tick`);
  }
  return p;
}

export function withBodyEdits({ repo, mergedPrs, openNumbers, readBodyEdit = defaultReadBodyEdit, now = Date.now() }) {
  const open = new Set(openNumbers.map(Number));
  let failures = 0;
  const rows = mergedPrs.map((m) => {
    if (!isTrustedSupersedeAuthor(m) || !parseSupersedes(m.body).some((t) => open.has(t))) return m;
    try { return validateSnapshot(readBodyEdit({ repo, pr: m.number }), m, now); }
    catch { failures += 1; return { ...m, bodyEditUnknown: true }; }
  });
  return { rows, failures };
}

/** Low-level open numbers; the daemon requires count proof via requireComplete before authorizing effects. */
export function defaultReadOpenNumbers({ repo, exec = execFileSync, requireComplete = false }) {
  return readPullPages({ repo, state: 'open', exec, requireComplete }).map(p => p.number);
}

/** One candidate's state, read fresh, with its COMPLETE comment thread (paginated — a hold past comment 100 still counts). */
export function defaultReadPr({ repo, pr, exec = execFileSync, readComments = readCompletePrComments }) {
  const view = ghJson(['pr', 'view', String(pr), '--repo', slugOf(repo), '--json', 'id,number,state,headRefOid,labels'], exec);
  return { ...view, comments: readComments(pr, { repo: slugOf(repo), exec }) };
}

/** Post the hold through the stand-down CLI (comment + `review-status:stood-down` + `superseded` labels). */
export function defaultPostHold({ repo, hold, exec = execFileSync }) {
  try {
    const out = exec(process.execPath, [STAND_DOWN_CLI, String(hold.pr), `--repo=${slugOf(repo)}`, '--reason=superseded',
      `--superseded-by=${hold.by}`, ...(hold.mergedAt ? [`--merged-at=${hold.mergedAt}`] : []), `--actor=${SUPERSEDE_WATCH_ACTOR}`], {
      stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    });
    const last = String(out || '').trim().split('\n').at(-1) || '{}';
    const parsed = JSON.parse(last);
    return { ok: !!parsed.ok, labeled: !!parsed.labeled };
  } catch (e) {
    return { ok: false, error: String(e?.stderr || e?.message || e).trim().split('\n')[0] };
  }
}

function validateCandidate(p, pr) {
  if (p?.number !== pr || !['OPEN', 'CLOSED', 'MERGED'].includes(p?.state)
    || typeof p.id !== 'string' || !p.id || !/^[a-f0-9]{40}$/i.test(p.headRefOid ?? '')
    || !Array.isArray(p.comments)) throw new Error(`unreadable candidate PR #${pr} identity/state; operator must inspect evidence and retry next tick`);
}

/**
 * One repo's pass. Never throws.
 * @returns {{repo:string, holds:Array<object>, applied:Array<object>, skipped?:string, error?:string}}
 */
export function runSupersedeWatch({
  repo, apply = true, settings = resolveSupersedeSettings(), now = Date.now(),
  readMergedPrs, readOpenNumbers, readPr, postHold, readBodyEdit, exec = execFileSync,
} = {}) {
  if (!settings?.hold) return { repo, holds: [], applied: [], skipped: 'supersede hold is off' };
  try {
    let calls = 0;
    const boundedExec = (...args) => {
      if (++calls > 256) throw new Error('supersede evidence call cap reached; operator must inspect the inventory and retry next tick');
      return exec(...args);
    };
    readMergedPrs ??= args => defaultReadMergedPrs({ ...args, exec: boundedExec, requireComplete: true });
    readOpenNumbers ??= args => defaultReadOpenNumbers({ ...args, exec: boundedExec, requireComplete: true });
    readBodyEdit ??= args => defaultReadBodyEdit({ ...args, exec: boundedExec });
    readPr ??= args => defaultReadPr({ ...args, exec: boundedExec });
    postHold ??= args => defaultPostHold({ ...args, exec: boundedExec });
    const evidence = [];
    const openNumbers = readOpenNumbers({ repo });
    const { rows: mergedPrs, failures: bodyEditFailures } = withBodyEdits({
      repo, mergedPrs: readMergedPrs({ repo, lookbackDays: settings.lookbackDays, now }), openNumbers, readBodyEdit, now });
    const candidates = supersedeCandidates({ mergedPrs, openNumbers });
    // Re-read each candidate: it must still be OPEN, and its own thread decides idempotency.
    const openPrs = candidates.map((pr) => {
      const p = readPr({ repo, pr });
      validateCandidate(p, pr);
      return p;
    }).filter((p) => p.state.toUpperCase() === 'OPEN');
    const holds = planSupersedeHolds({ mergedPrs, openPrs, settings });
    const applied = apply ? holds.map((hold) => {
      try {
        const source = mergedPrs.find(p => p.number === hold.by);
        const fresh = validateSnapshot(readBodyEdit({ repo, pr: hold.by }), source, now);
        if (snapshotVersion(fresh) !== snapshotVersion(source)) throw new Error('source version changed; retry next tick');
        const candidate = openPrs.find(p => p.number === hold.pr);
        const current = readPr({ repo, pr: hold.pr });
        validateCandidate(current, hold.pr);
        if (current.state !== 'OPEN' || current.id !== candidate.id || current.headRefOid !== candidate.headRefOid)
          throw new Error('candidate moved before write; retry next tick');
        if (!planSupersedeHolds({ mergedPrs: [fresh], openPrs: [current], settings }).length)
          throw new Error('hold authority changed before write; retry next tick');
        const bound = { candidateId: current.id, candidateHead: current.headRefOid,
          sourceId: fresh.id, version: fresh.updatedAt, snapshot: snapshotVersion(fresh) };
        evidence.push({ pr: hold.pr, ...bound });
        const posted = postHold({ repo, hold });
        if (!posted?.ok) return { ...hold, ...posted, ok: false };
        const observed = readPr({ repo, pr: hold.pr });
        validateCandidate(observed, hold.pr);
        if (observed.state !== 'OPEN' || observed.id !== current.id || observed.headRefOid !== current.headRefOid
          || !supersedeHoldsOn(observed.comments).includes(hold.by))
          throw new Error('effect read-back incomplete; inspect the PR and retry next tick');
        return { ...hold, ...posted };
      }
      catch (e) { return { ...hold, ok: false, error: String(e?.message || e).split('\n')[0] }; }
    }) : [];
    return { repo, holds, applied, ...(evidence.length ? { evidence } : {}), ...(bodyEditFailures ? { bodyEditFailures } : {}) };
  } catch (e) {
    return { repo, holds: [], applied: [], blocked: true, error: String(e?.message || e).split('\n')[0] };
  }
}

/** One printable line per hold this pass planned or posted. */
export function formatSupersedeLines(result) {
  const lines = [];
  for (const r of result?.repos ?? []) {
    if (r.error) lines.push(`supersede-watch ${r.repo} — evidence unreadable; dispatch blocked (retried next tick): ${r.error}`);
    if (r.bodyEditFailures) lines.push(`supersede-watch ${r.repo} — ${r.bodyEditFailures} merged-PR body-edit read(s) failed; those PRs' Supersedes lines are ignored this tick (retried next tick)`);
    const applied = new Map((r.applied ?? []).map((a) => [a.pr, a]));
    for (const h of r.holds ?? []) {
      const a = applied.get(h.pr);
      const outcome = !a ? 'planned (dry run)' : a.ok ? `stood down${a.labeled ? ', labelled superseded' : ' (label failed)'}` : `FAILED (${a.error ?? 'unknown'})`;
      lines.push(`supersede-watch ${r.repo} PR #${h.pr} — superseded by merged #${h.by} — ${outcome}; closing needs an operator decision`);
    }
  }
  return lines;
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  const flags = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
  const repos = typeof flags.repo === 'string' ? [flags.repo] : Object.values(CONSTELLATION_REPOS).map((r) => r.slug);
  const result = { repos: repos.map((repo) => runSupersedeWatch({ repo, apply: flags.apply === true })) };
  for (const line of formatSupersedeLines(result)) process.stderr.write(`${line}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
