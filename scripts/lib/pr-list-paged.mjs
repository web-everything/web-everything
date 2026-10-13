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
  return `query{repository(owner:"${owner}",name:"${name}"){pullRequests(states:OPEN,first:${pageSize}${cursor},orderBy:{field:CREATED_AT,direction:DESC}){totalCount pageInfo{hasNextPage endCursor} nodes{number title url isDraft createdAt updatedAt headRefName headRefOid baseRefName isCrossRepository mergeable mergeStateStatus reviewDecision labels(first:100){nodes{id name description color}} commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{__typename ...on CheckRun{name status conclusion startedAt completedAt detailsUrl checkSuite{workflowRun{workflow{name}}}} ...on StatusContext{context state targetUrl createdAt}}}}}}}}}}}`;
}

const ZERO = '0001-01-01T00:00:00Z';
const mapCtx = c => c.__typename === 'CheckRun'
  ? { __typename: 'CheckRun', completedAt: c.completedAt ?? ZERO, conclusion: c.conclusion ?? '', detailsUrl: c.detailsUrl,
    name: c.name, startedAt: c.startedAt ?? ZERO, status: c.status, workflowName: c.checkSuite?.workflowRun?.workflow?.name ?? '' }
  : { __typename: 'StatusContext', context: c.context, startedAt: c.createdAt, state: c.state, targetUrl: c.targetUrl ?? '' };

/** PURE: exactly gh pr list --json's labels and flattened statusCheckRollup shape. */
export function mapGraphqlPr(n) {
  return { number: n.number, title: n.title, url: n.url, isDraft: n.isDraft, createdAt: n.createdAt, updatedAt: n.updatedAt,
    headRefName: n.headRefName, headRefOid: n.headRefOid, baseRefName: n.baseRefName, isCrossRepository: n.isCrossRepository,
    mergeable: n.mergeable, mergeStateStatus: n.mergeStateStatus, reviewDecision: n.reviewDecision ?? '',
    labels: n.labels?.nodes ?? [],
    statusCheckRollup: (n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []).map(mapCtx) };
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
export function listOpenPrsLightPaged({ repo, exec, pageSize, pageRetries = 1, maxRows = 500, execOpts = {} }) {
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
