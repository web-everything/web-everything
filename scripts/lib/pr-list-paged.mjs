/**
 * @file scripts/lib/pr-list-paged.mjs
 * @description Small, synchronous GraphQL pages for the shared open-PR snapshot, with cached per-PR heavy reads.
 *
 * WHY: live 2026-10-12/13, the single heavy `gh pr list` request for ~45 PRs repeatedly returned HTTP 504 Gateway
 *   Timeout. The CI-red recovery watch, drain and smoke reconcile could not read the shared snapshot. Keep
 *   comments/body/files out of the bulk query; hydrate them with `gh pr view` only when the cached copy is stale.
 *   A failed page never publishes a partial list. The shared snapshot and drain candidate listing use this reader.
 *
 * SETTINGS: `prListPaging` in scripts/settings/pr-list-paging.json. `pageSize` (20, range 1–100) bounds each page;
 *   `pageRetries` (1, range 0–3) retries only shared gh transient server/JSON failures; `heavyMaxAgeSeconds`
 *   (600, range 0–86400) caps reuse when updatedAt and headRefOid still match. Layers: standard → platform → tool
 *   → env WE_PR_LIST_PAGE_SIZE (pageSize only). resolvePrListPaging returns each leaf's source; policy-cascade
 *   logs those sources in daemons. All GitHub execution is injected so pure transforms and tests need no network.
 */
import { readDeclaredSettings } from './settings-files.mjs';
import { cascadePolicy } from './policy-cascade.mjs';
import { GH_TRANSIENT_SERVER_PATTERNS, GH_JSON_PARSE_FAILURE_PATTERNS } from './gh-throttle.mjs';
import { isGhDeferred } from './gh-deferred.mjs';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { withFileLock, writeJsonAtomic } from './atomic-json-file.mjs';
import { prSnapshotDir } from './pr-snapshot-store.mjs';
import { isUnderTest } from './under-test.mjs';

export const HEAVY_FIELDS = Object.freeze(['comments', 'body', 'files']);
export const PAGED_LIGHT_FIELDS = Object.freeze(['number', 'title', 'url', 'isDraft', 'createdAt', 'updatedAt', 'headRefName',
  'headRefOid', 'baseRefName', 'isCrossRepository', 'mergeable', 'mergeStateStatus', 'reviewDecision', 'labels', 'statusCheckRollup']);
export const PR_LIST_PAGING_DEFAULTS = Object.freeze({ pageSize: 20, pageRetries: 1, heavyMaxAgeSeconds: 600 });
export const PR_LIST_PAGE_SIZE_ENV = 'WE_PR_LIST_PAGE_SIZE';

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const failureText = cause => String(cause?.stderr || cause?.message || cause);
const execOptions = overrides => ({ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  maxBuffer: 64 * 1024 * 1024, timeout: 60_000, killSignal: 'SIGKILL', ...overrides });

/** Preserve gh stderr and the original cause for callers' existing failure classifiers. */
export class PrListUnreadableError extends Error {
  constructor({ repo, stage, page, number, cause }) {
    const where = stage === 'page' ? `page ${page}` : `PR #${number}`;
    super(`open-PR list unreadable for ${repo}: ${stage} ${where} failed: ${failureText(cause).split(/\r?\n/)[0]}`, { cause });
    this.name = 'PrListUnreadableError';
    this.code = 'pr-list-unreadable';
    this.unreadable = true;
    this.repo = repo;
    this.stage = stage;
    if (stage === 'page') this.page = page;
    else this.number = number;
    this.stderr = cause?.stderr;
  }
}

/** Resolve validated leaves and their sources through the shared settings cascade. Never throws. */
export function resolvePrListPaging({ env = process.env, file } = {}) {
  try {
    const src = file === undefined ? readDeclaredSettings().settings : file;
    const raw = env?.[PR_LIST_PAGE_SIZE_ENV];
    const pageSize = raw != null && String(raw).trim() !== '' ? Number(raw) : undefined;
    const c = cascadePolicy('prListPaging', isObj(src?.prListPaging) ? src.prListPaging : undefined, {
      env, standard: PR_LIST_PAGING_DEFAULTS, envValues: { pageSize },
      valid: { pageSize: n => Number.isInteger(n) && n >= 1 && n <= 100,
        pageRetries: n => Number.isInteger(n) && n >= 0 && n <= 3,
        heavyMaxAgeSeconds: n => Number.isInteger(n) && n >= 0 && n <= 86400 },
    });
    return { ...PR_LIST_PAGING_DEFAULTS, ...c.value, source: c.sources };
  } catch {
    return { ...PR_LIST_PAGING_DEFAULTS,
      source: Object.fromEntries(Object.keys(PR_LIST_PAGING_DEFAULTS).map(k => [k, 'standard'])) };
  }
}

/** PURE: an ordered light page; quote the opaque cursor as a GraphQL string. */
export function buildOpenPrPageQuery({ repo, pageSize, after = null }) {
  if (typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new TypeError('repo must be an owner/name slug');
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new TypeError('pageSize must be an integer from 1 to 100');
  const [owner, name] = repo.split('/');
  const cursor = after === null ? '' : `,after:${JSON.stringify(after)}`;
  return `query{repository(owner:"${owner}",name:"${name}"){pullRequests(states:OPEN,first:${pageSize}${cursor},orderBy:{field:CREATED_AT,direction:DESC}){totalCount pageInfo{hasNextPage endCursor} nodes{number title url isDraft createdAt updatedAt headRefName headRefOid baseRefName isCrossRepository mergeable mergeStateStatus reviewDecision labels(first:100){nodes{id name description color}} commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:100){pageInfo{hasNextPage} totalCount nodes{__typename ...on CheckRun{name status conclusion startedAt completedAt detailsUrl databaseId checkSuite{app{slug databaseId} workflowRun{workflow{name}}}} ...on StatusContext{context state targetUrl createdAt}}}}}}}}}}}`;
}

const ZERO = '0001-01-01T00:00:00Z';
const mapCtx = c => c.__typename === 'CheckRun'
  ? { __typename: 'CheckRun', completedAt: c.completedAt ?? ZERO, conclusion: c.conclusion ?? '', detailsUrl: c.detailsUrl,
    name: c.name, startedAt: c.startedAt ?? ZERO, status: c.status, workflowName: c.checkSuite?.workflowRun?.workflow?.name ?? '',
    appSlug: c.checkSuite?.app?.slug ?? '', appId: c.checkSuite?.app?.databaseId ?? null, ...(Number.isInteger(c.databaseId) ? { checkRunId: c.databaseId } : {}) }
  : { __typename: 'StatusContext', context: c.context, startedAt: c.createdAt, state: c.state, targetUrl: c.targetUrl ?? '' };

/** GraphQL hides `checkSuite.app` for some app-posted checks (live #6873: red-team, app null). For each LIVE,
 *  workflow-less CheckRun with no app, read the posting app over REST so the planner can bind provenance to it.
 *  A failed read leaves the app empty: the planner then fails closed. Bounded per list; costs nothing otherwise.
 *  Rotate attempts across refreshes, including failures, so a pending prefix cannot starve later checks.
 *  A check-run's posting app is immutable: retain successful provenance by repo/check ID only while that
 *  check is still live and workflow-less. Snapshot callers persist this state under their existing lock. */
const APP_LOOKUP_CAP = 20;
const APP_LOOKUP_REPO_CAP = 128;
const appLookupStates = new Map();
export function resolveCheckApps({ repo, rows, exec, execOpts = {}, checkAppState }) {
  const state = checkAppState ?? appLookupStates.get(repo) ?? {};
  const previous = state.repo === repo ? state : {};
  const candidates = new Map();
  for (const row of rows) {
    for (const c of row.statusCheckRollup ?? []) {
      if (c?.__typename !== 'CheckRun' || String(c.status).toUpperCase() === 'COMPLETED' || c.workflowName || c.appId !== null || !Number.isInteger(c.checkRunId)) continue;
      if (!candidates.has(c.checkRunId)) candidates.set(c.checkRunId, []);
      candidates.get(c.checkRunId).push(c);
    }
  }
  const apps = {};
  const apply = (id, app) => {
    apps[id] = app;
    for (const c of candidates.get(id)) Object.assign(c, app);
  };
  const pending = [];
  for (const id of candidates.keys()) {
    const app = previous.apps?.[id];
    if (Number.isInteger(app?.appId) && typeof app.appSlug === 'string') apply(id, { appId: app.appId, appSlug: app.appSlug });
    else pending.push(id);
  }
  pending.sort((a, b) => a - b);
  // Use a numeric successor so completion/removal of the last attempted check cannot reset progress.
  const start = Math.max(0, pending.findIndex(id => id > previous.cursor));
  let cursor = previous.cursor ?? null;
  for (let i = 0; i < Math.min(APP_LOOKUP_CAP, pending.length); i++) {
    const id = pending[(start + i) % pending.length];
    // Advance even on an unreadable answer: unknown checks hold, but cannot monopolize the budget.
    cursor = id;
    try {
      const app = JSON.parse(String(exec('gh', ['api', `repos/${repo}/check-runs/${id}`], execOptions(execOpts))))?.app;
      if (Number.isInteger(app?.id)) apply(id, { appId: app.id, appSlug: typeof app.slug === 'string' ? app.slug : '' });
    } catch { /* unreadable: leave the app empty (fail closed) */ }
  }
  // Prune disappeared/completed checks; explicit state also carries progress across fresh Node processes.
  Object.assign(state, { repo, cursor: candidates.size ? cursor : null, apps });
  if (!checkAppState) {
    appLookupStates.delete(repo);
    appLookupStates.set(repo, state);
    if (appLookupStates.size > APP_LOOKUP_REPO_CAP) appLookupStates.delete(appLookupStates.keys().next().value);
  }
  return rows;
}

/** `gh pr list --json statusCheckRollup` (the runner's tick snapshot, `open-pr-fetch.mjs`) carries neither a check-run id
 *  nor its app. For each row with a LIVE, workflow-less CheckRun and no app, read the head commit's check runs over REST
 *  and bind appId/appSlug by check name — but only when every same-named run on that commit agrees on one app. Any
 *  failure, missing run, disagreement, a partial page (`total_count` above the runs returned) or no still-live same-name
 *  run leaves the app empty: the planner then fails closed. `filter=all` shows superseded same-name runs of other apps
 *  to the agreement test. Bounded per list; reserve the next batch with a persisted SHA cursor before the REST reads,
 *  so clock phase, failed reads and fresh processes cannot repeatedly select only the same pending prefix.
 *  `repo` null → the cwd repo (gh placeholders). */
const COMMIT_LOOKUP_CAP = 30;
const SHA_RE = /^[0-9a-f]{40}$/;
const commitLookupCursors = new Map();

function nextCommitLookups(shas, { repo, execOpts, env }) {
  if (shas.length <= COMMIT_LOOKUP_CAP) return shas;
  const identity = repo || env.GH_REPO;
  const key = identity ? `repo:${identity.toLowerCase()}` : `cwd:${resolve(execOpts.cwd || process.cwd())}`;
  const select = cursor => {
    // A successor survives removal of the last attempted head and changes to input order/size.
    const start = SHA_RE.test(cursor) ? Math.max(0, shas.findIndex(sha => sha > cursor)) : 0;
    return Array.from({ length: COMMIT_LOOKUP_CAP }, (_, i) => shas[(start + i) % shas.length]);
  };
  // Hermetic tests/fake gh must never touch the host store. An explicit fixture directory exercises persistence.
  if ((isUnderTest(env) || env.FAKE_GH_FIXTURE) && !env.WE_PR_SNAPSHOT_DIR) {
    const batch = select(commitLookupCursors.get(key));
    commitLookupCursors.delete(key);
    commitLookupCursors.set(key, batch.at(-1));
    if (commitLookupCursors.size > APP_LOOKUP_REPO_CAP) commitLookupCursors.delete(commitLookupCursors.keys().next().value);
    return batch;
  }
  try {
    const dir = join(prSnapshotDir(env), 'commit-app-cursors');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${createHash('sha256').update(key).digest('hex')}.json`);
    return withFileLock(`${path}.lock`, () => {
      let cursor;
      try { cursor = JSON.parse(readFileSync(path, 'utf8'))?.cursor; }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      const batch = select(cursor);
      // Publish under the lock, BEFORE network IO; failures/crashes cannot monopolize a batch.
      // Only scheduling state is stored here. App provenance is always fetched afresh.
      writeJsonAtomic(path, { cursor: batch.at(-1) });
      return batch;
    }, { timeoutMs: 1000 });
  } catch {
    console.error('check-app lookup progress unavailable; restore writable PR snapshot storage; skipping commit lookups');
    return []; // no unsynchronized prefix fallback; unknown apps remain closed
  }
}

export function resolveCheckAppsByCommit({ repo, rows, exec, execOpts = {}, env = execOpts.env ?? process.env }) {
  const wanted = new Map(); // headRefOid -> checks needing an app
  for (const row of rows) {
    if (typeof row?.headRefOid !== 'string' || !SHA_RE.test(row.headRefOid)) continue;
    for (const c of row.statusCheckRollup ?? []) {
      if (c?.__typename !== 'CheckRun' || String(c.status).toUpperCase() === 'COMPLETED' || c.workflowName || c.appId || c.appSlug) continue;
      if (!wanted.has(row.headRefOid)) wanted.set(row.headRefOid, []);
      wanted.get(row.headRefOid).push(c);
    }
  }
  const shas = [...wanted.keys()].sort();
  const base = repo ? `repos/${repo}` : 'repos/{owner}/{repo}';
  for (const sha of nextCommitLookups(shas, { repo, execOpts, env })) {
    try {
      const body = JSON.parse(String(exec('gh', ['api', `${base}/commits/${sha}/check-runs?per_page=100&filter=all`], execOptions(execOpts))));
      const runs = body?.check_runs;
      // A partial page could hide a same-named run of another app: bind nothing from it.
      if (!Array.isArray(runs) || !Number.isInteger(body.total_count) || body.total_count > runs.length) continue;
      for (const c of wanted.get(sha)) {
        const same = runs.filter(r => r?.name === c.name);
        const ids = new Set(same.map(r => r?.app?.id));
        const stillLive = same.some(r => String(r?.status).toLowerCase() !== 'completed');
        if (same.length === 0 || !stillLive || ids.size !== 1 || !Number.isInteger(same[0].app?.id)) continue;
        Object.assign(c, { appId: same[0].app.id, appSlug: typeof same[0].app.slug === 'string' ? same[0].app.slug : '' });
      }
    } catch { /* unreadable: leave the app empty (fail closed) */ }
  }
  return rows;
}

/** Connection metadata is required; flattened gh rows cannot prove completeness. */
export function rollupEvidence(commit) {
  const c = commit?.statusCheckRollup?.contexts;
  return { rowsHead: typeof commit?.oid === 'string' && SHA_RE.test(commit.oid) ? commit.oid : null,
    rowsComplete: c?.pageInfo?.hasNextPage === false && Number.isInteger(c?.totalCount) && c.totalCount >= 0
      && Array.isArray(c?.nodes) && c.nodes.length === c.totalCount
      && c.nodes.every(n => n && ['CheckRun', 'StatusContext'].includes(n.__typename)) };
}

/** Legacy lists omit metadata. Bound reads to ten batches of twenty heads.
 * Unknown evidence holds review until the next tick or an operator repairs the read.
 */
export function enrichPrRollupEvidence({ repo, rows, exec, execOpts = {} }) {
  for (const pr of rows) Object.assign(pr, { rowsComplete: false, rowsHead: null });
  const heads = [...new Set(rows.map(pr => pr.headRefOid).filter(sha => typeof sha === 'string' && SHA_RE.test(sha)))].slice(0, 200);
  for (let offset = 0; offset < heads.length; offset += 20) {
    const batch = heads.slice(offset, offset + 20);
    const objects = batch.map((sha, i) => `h${i}:object(oid:"${sha}"){...on Commit{oid statusCheckRollup{contexts(first:100){pageInfo{hasNextPage} totalCount nodes{__typename ...on CheckRun{name status conclusion startedAt completedAt detailsUrl databaseId checkSuite{app{slug databaseId} workflowRun{workflow{name}}}} ...on StatusContext{context state targetUrl createdAt}}}}}}`).join(' ');
    try {
      const out = JSON.parse(String(exec('gh', ['api', 'graphql', '-F', `owner=${repo?.split('/')[0] || '{owner}'}`,
        '-F', `name=${repo?.split('/')[1] || '{repo}'}`, '-f',
        `query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${objects}}}`], execOptions(execOpts))));
      if (out?.errors?.length) continue;
      batch.forEach((sha, i) => {
        const commit = out?.data?.repository?.[`h${i}`];
        if (commit?.oid !== sha) return;
        for (const pr of rows.filter(pr => pr.headRefOid === sha)) {
          Object.assign(pr, rollupEvidence(commit));
          const nodes = commit?.statusCheckRollup?.contexts?.nodes;
          if (pr.rowsComplete === true) pr.statusCheckRollup = nodes.map(mapCtx);
        }
      });
    } catch { /* unknown: retain fail-closed evidence */ }
  }
  return rows;
}

/** PURE: exactly gh pr list --json's labels and flattened statusCheckRollup shape. */
export function mapGraphqlPr(n) {
  return { ...rollupEvidence(n.commits?.nodes?.[0]?.commit), number: n.number, title: n.title, url: n.url, isDraft: n.isDraft, createdAt: n.createdAt, updatedAt: n.updatedAt,
    headRefName: n.headRefName, headRefOid: n.headRefOid, baseRefName: n.baseRefName, isCrossRepository: n.isCrossRepository,
    mergeable: n.mergeable, mergeStateStatus: n.mergeStateStatus, reviewDecision: n.reviewDecision ?? '',
    labels: n.labels?.nodes ?? [],
    statusCheckRollup: (n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []).filter(n => n && ['CheckRun', 'StatusContext'].includes(n.__typename)).map(mapCtx) };
}

/** PURE: reject GraphQL errors even when accompanied by partial data. */
export function parseOpenPrPage(text) {
  const data = JSON.parse(String(text));
  if (data?.errors?.length) throw new Error(data.errors.map(e => e.message ?? String(e)).join('\n'));
  const prs = data?.data?.repository?.pullRequests;
  if (!Array.isArray(prs?.nodes) || typeof prs?.pageInfo?.hasNextPage !== 'boolean'
    || !Number.isInteger(prs.totalCount) || prs.totalCount < 0
    || !(prs.pageInfo.endCursor === null || typeof prs.pageInfo.endCursor === 'string')
    || (prs.pageInfo.hasNextPage && !prs.pageInfo.endCursor)) {
    throw new Error('missing open-PR page data');
  }
  return { rows: prs.nodes.map(mapGraphqlPr), hasNextPage: prs.pageInfo.hasNextPage,
    endCursor: prs.pageInfo.endCursor, totalCount: prs.totalCount };
}

/** PURE: share the gh runner's transient server and truncated JSON classifiers. */
export function isTransientGhFailure(text) {
  return [...GH_TRANSIENT_SERVER_PATTERNS, ...GH_JSON_PARSE_FAILURE_PATTERNS].some(re => re.test(String(text ?? '')));
}

/** PURE: both PR identity stamps and the heavy-field age must still be fresh. */
export function heavyIsFresh(cached, row, { nowMs, maxAgeMs }) {
  return !!cached && cached.updatedAt === row.updatedAt && cached.headRefOid === row.headRefOid
    && nowMs - cached.fetchedAtMs < maxAgeMs;
}

function readPage({ repo, exec, query, page, pageRetries, execOpts }) {
  for (let attempt = 0; ; attempt++) {
    try {
      // `gh api graphql` has no --repo flag, so the per-owner App token shim cannot see the target owner from argv.
      // GH_REPO names it (live 2026-10-13: without it frontier-ui/plateau-app pages got "Could not resolve to a Repository").
      const text = exec('gh', ['api', 'graphql', '-f', `query=${query}`],
        execOptions({ ...execOpts, env: { ...(execOpts.env || process.env), GH_REPO: repo } }));
      if (isGhDeferred(text)) return { deferred: isObj(text) && !Buffer.isBuffer(text) ? text : JSON.parse(String(text)) };
      return { ...parseOpenPrPage(text), bytes: Buffer.byteLength(String(text)) };
    } catch (cause) {
      if (attempt < pageRetries && isTransientGhFailure(failureText(cause))) continue;
      throw new PrListUnreadableError({ repo, stage: 'page', page, cause });
    }
  }
}

/** SYNC: complete pages only; failure or deferral never returns previously read rows. */
export function listOpenPrsLightPaged({ repo, exec, pageSize, pageRetries = 1, maxRows = 500, execOpts = {}, checkAppState }) {
  const started = Date.now();
  const rows = [];
  let pages = 0, bytes = 0, after = null, hasNextPage = false, totalCount;
  do {
    const query = buildOpenPrPageQuery({ repo, pageSize, after });
    const result = readPage({ repo, exec, query, page: pages + 1, pageRetries, execOpts });
    if (result.deferred) return { deferred: result.deferred };
    pages++;
    bytes += result.bytes;
    rows.push(...result.rows);
    ({ hasNextPage, totalCount } = result);
    after = result.endCursor;
  } while (hasNextPage && rows.length < maxRows);
  resolveCheckApps({ repo, rows, exec, execOpts, checkAppState });
  return { rows, pages, bytes, ms: Date.now() - started, truncated: hasNextPage && rows.length >= maxRows, totalCount };
}

function readHeavy({ repo, row, exec, fields, execOpts }) {
  try {
    const text = exec('gh', ['pr', 'view', String(row.number), '--repo', repo, '--json', fields.join(',')], execOptions(execOpts));
    const data = JSON.parse(String(text));
    if (!isObj(data) || isGhDeferred(data) || fields.some(field => !Object.hasOwn(data, field))) {
      throw new Error('missing PR heavy-field data');
    }
    return data;
  } catch (cause) {
    throw new PrListUnreadableError({ repo, stage: 'hydrate', number: row.number, cause });
  }
}

/** SYNC: return new rows and a cache containing only PRs still in the current list. */
export function hydrateHeavyFields({ repo, rows, exec, cache = {}, nowMs = Date.now(), maxAgeMs,
  fields = HEAVY_FIELDS, execOpts = {} }) {
  const nextCache = {};
  let fetched = 0, reused = 0;
  const hydrated = rows.map(row => {
    let entry = cache[row.number];
    if (heavyIsFresh(entry, row, { nowMs, maxAgeMs })) reused++;
    else {
      const data = readHeavy({ repo, row, exec, fields, execOpts });
      entry = { updatedAt: row.updatedAt, headRefOid: row.headRefOid, fetchedAtMs: nowMs,
        ...Object.fromEntries(fields.map(field => [field, data[field]])) };
      fetched++;
    }
    nextCache[row.number] = entry;
    return { ...row, ...Object.fromEntries(fields.map(field => [field, entry[field]])) };
  });
  return { rows: hydrated, cache: nextCache, fetched, reused };
}


/** SYNC: page the live set, then hydrate selected rows; unreadable never means partial or empty. */
export function listOpenPrsPagedHydrated({ repo, exec, paging, heavyFields, needsHeavy = () => true,
  cache = {}, seed = [], nowMs = Date.now(), maxRows = 500, execOpts = {} }) {
  const light = listOpenPrsLightPaged({ repo, exec, pageSize: paging.pageSize,
    pageRetries: paging.pageRetries, maxRows, execOpts });
  if (light.deferred) throw new PrListUnreadableError({ repo, stage: 'page', page: 1,
    cause: new Error('gh deferred the page (low budget)') });
  const working = { ...cache };
  const byNumber = new Map(light.rows.map(row => [row.number, row]));
  const maxAgeMs = paging.heavyMaxAgeSeconds * 1000;
  const hasFields = entry => !!entry && heavyFields.every(field => Object.hasOwn(entry, field));
  for (const row of seed) {
    const live = byNumber.get(row.number);
    if (!live || row.updatedAt !== live.updatedAt || row.headRefOid !== live.headRefOid || !hasFields(row)
      || (hasFields(working[row.number]) && heavyIsFresh(working[row.number], live, { nowMs, maxAgeMs }))) continue;
    working[row.number] = { updatedAt: row.updatedAt, headRefOid: row.headRefOid, fetchedAtMs: nowMs,
      ...Object.fromEntries(heavyFields.map(field => [field, row[field]])) };
  }
  const need = light.rows.filter(needsHeavy);
  let rows = light.rows, hydrated = 0, reused = 0;
  if (heavyFields.length && need.length) {
    // A prior body-only pass cannot supply files; preserve untouched entries for other open rows.
    for (const row of need) {
      if (!hasFields(working[row.number])) delete working[row.number];
    }
    const result = hydrateHeavyFields({ repo, rows: need, exec, cache: working, nowMs, maxAgeMs,
      fields: heavyFields, execOpts });
    const heavyByNumber = new Map(result.rows.map(row => [row.number, row]));
    rows = light.rows.map(row => heavyByNumber.get(row.number) || row);
    Object.assign(working, result.cache);
    hydrated = result.fetched;
    reused = result.reused;
  }
  const nextCache = Object.fromEntries(light.rows.filter(row => working[row.number])
    .map(row => [row.number, working[row.number]]));
  return { rows, truncated: light.truncated, totalCount: light.totalCount, pages: light.pages,
    ms: light.ms, hydrated, reused, cache: nextCache };
}

/** PURE: a PR-list read must never look complete when it is not. Unique PR numbers (duplicates cannot hide an
 *  omitted PR) are counted against GitHub's own `totalCount`; a shortfall, without a declared truncation, fails
 *  closed with a named reason. */
export function assertInventoryComplete({ repo, rows, totalCount, truncated = false }) {
  if (rows.some(r => !Number.isInteger(r?.number) || r.number < 1)) {
    throw new PrListUnreadableError({ repo, stage: 'page', page: 'inventory',
      cause: new Error('a listed PR has a malformed number (not a positive integer) — refusing an inconsistent inventory') });
  }
  const unique = new Set(rows.map(r => r.number)).size;
  const have = unique;
  if (unique < rows.length) {
    throw new PrListUnreadableError({ repo, stage: 'page', page: 'inventory',
      cause: new Error(`duplicate PR numbers in the listing (${unique} unique of ${rows.length} rows) — refusing an inconsistent inventory`) });
  }
  if (truncated || !Number.isInteger(totalCount) || have >= totalCount) return;
  throw new PrListUnreadableError({ repo, stage: 'page', page: 'inventory',
    cause: new Error(`pages carried ${have} unique of ${totalCount} open PRs (${have} of ${totalCount}) — refusing a partial inventory`) });
}

/** PURE: parse the stdout of a `gh pr list --json` read. Empty/blank output, non-JSON and non-array JSON are
 *  FAILURES (never an empty inventory); only a literal JSON list is a result. */
export function parseListOutput(text, { repo = '' } = {}) {
  const raw = text == null ? '' : String(text);
  const where = repo ? ` for ${repo}` : '';
  if (!raw.trim()) throw Object.assign(new Error(`open-PR list${where} returned empty output — refusing to read it as an empty inventory`), { code: 'pr-list-empty' });
  let parsed;
  try { parsed = JSON.parse(raw); } catch (cause) { throw Object.assign(new Error(`open-PR list${where} was not JSON`, { cause }), { code: 'pr-list-malformed' }); }
  if (!Array.isArray(parsed)) throw Object.assign(new Error(`open-PR list${where} was not a list — refusing to read it as an empty inventory`), { code: 'pr-list-malformed' });
  return parsed;
}

/** {@link listOpenPrsPagedHydrated} that refuses a short inventory (drain-facing). */
export function listOpenPrsPagedHydratedComplete(o) {
  const listed = listOpenPrsPagedHydrated(o);
  assertInventoryComplete({ repo: o.repo, rows: listed.rows, totalCount: listed.totalCount, truncated: listed.truncated });
  return listed;
}
