/**
 * Single-PR drain context (green events and catch-up). The live, lean inventory owns membership; a cache-only
 * shared snapshot contributes full rows only at the same number/head/updatedAt. Unknown
 * inventory or evidence defers catch-up; legacy green events retain their full-list fallback. Related components
 * are refreshed before returning any evidence to gates; none of the merge gates lives here.
 * IO is injected so cost, freshness, fallback and ordering can be exercised without GitHub.
 */
import { readFileSync, statSync } from 'node:fs';
import { writeJsonAtomic } from './atomic-json-file.mjs';
import { withFastDrainRoundLock, roundSnapshotTtl } from './fast-drain-scope.mjs';
import { mapWithConcurrency } from './drain-concurrency.mjs';
import { asItemId, isItemId } from '../readiness/lane-manifest.mjs';
import { isDegradedOpenPrListing, OPEN_PR_LIST_LIMIT } from './no-search-backed-pr-list.mjs';
import { assertInventoryComplete, buildOpenPrPageQuery, parseOpenPrPage } from './pr-list-paged.mjs';
import { queueFileOverlap, completeListedFiles } from './queue-file-overlap.mjs';

export const LEAN_OPEN_PR_FIELDS = 'number,headRefOid,updatedAt,baseRefName,isDraft,state';
export const fastDrainPrKey = (repo, number) => `${repo}#${number}`;

export function useFastDrainContext({ onlyPr, fromGreenEvent, fromCatchUp, listingSnapshot, onlyRepo, localSlug, listing, context }) {
  return onlyPr != null && (!!fromGreenEvent || (!!fromCatchUp && !!listingSnapshot)) && (!onlyRepo || onlyRepo === localSlug) && !!localSlug
    && listing !== 'live' && context !== 'live';
}

/** Reject incomplete inventories, including partial pages and repeated identities. */
export function validateLeanOpenPrs(inventory, maxRows = OPEN_PR_LIST_LIMIT, repo = '') {
  const { rows, totalCount, hasNextPage, truncated } = inventory ?? {};
  if (!Array.isArray(rows) || !Number.isInteger(totalCount) || totalCount < 0
    || hasNextPage !== false || truncated !== false) throw new Error('lean inventory incomplete');
  // The full listing's guard counts unique numbers and rejects duplicates/shortfalls.
  assertInventoryComplete({ repo, rows, totalCount, truncated });
  if (rows.length !== totalCount) throw new Error('lean inventory count changed during read');
  if (isDegradedOpenPrListing(rows.length, maxRows)) throw new Error('lean inventory truncated');
  for (const p of rows) {
    if (!/^[a-f0-9]{40}$/i.test(p.headRefOid ?? '') || !Number.isFinite(Date.parse(p.updatedAt))
      || typeof p.baseRefName !== 'string' || !p.baseRefName.trim() || typeof p.isDraft !== 'boolean' || p.state !== 'OPEN') {
      throw new Error('lean inventory incomplete');
    }
  }
  return rows;
}

/** Lean pages share the full listing's query ordering, parser and completeness guard.
 * No partial result escapes on transport errors, count drift, cursor loops or bounded truncation.
 */
export async function listLeanOpenPrsPaged({ repo, readPage, pageSize = 100, maxRows = OPEN_PR_LIST_LIMIT }) {
  const rows = [], cursors = new Set();
  let after = null, expectedCount;
  for (;;) {
    const query = buildOpenPrPageQuery({ repo, pageSize, after, inventoryOnly: true });
    const page = parseOpenPrPage(await readPage(query), { mapNode: node =>
      Object.fromEntries(LEAN_OPEN_PR_FIELDS.split(',').map(field => [field, node?.[field]])) });
    if (expectedCount !== undefined && page.totalCount !== expectedCount) throw new Error('lean inventory totalCount changed between pages');
    expectedCount = page.totalCount;
    if (page.rows.length > pageSize || (page.hasNextPage && page.rows.length !== pageSize)) throw new Error('lean inventory page truncated');
    rows.push(...page.rows);
    const inventory = { rows, totalCount: expectedCount, hasNextPage: page.hasNextPage, truncated: rows.length >= maxRows && page.hasNextPage };
    if (!page.hasNextPage) {
      validateLeanOpenPrs(inventory, maxRows, repo);
      return { ...inventory, rows: [...new Map(rows.map(row => [row.number, row])).values()] };
    }
    if (rows.length >= maxRows || expectedCount >= maxRows) throw new Error('lean inventory truncated');
    if (cursors.has(page.endCursor)) throw new Error('lean inventory cursor repeated');
    cursors.add(page.endCursor);
    after = page.endCursor;
  }
}

export function matchingSnapshotRow(snapshot, live) {
  return snapshot?.number === live.number && snapshot.headRefOid === live.headRefOid
    && snapshot.updatedAt === live.updatedAt;
}

function usableSnapshotRow(row, live) {
  return matchingSnapshotRow(row, live) && row.rowsComplete === true && row.rowsHead === row.headRefOid
    && ['title', 'body', 'headRefName', 'mergeable', 'mergeStateStatus', 'reviewDecision'].every(f => Object.hasOwn(row, f))
    && typeof row.body === 'string' && [row.labels, row.files, row.statusCheckRollup].every(Array.isArray);
}

function requireFullPr(row, number) {
  if (typeof row?.baseRefName !== 'string' || !row.baseRefName.trim()) {
    throw new Error(`PR #${number} base branch unreadable — cannot use incomplete full PR evidence`);
  }
  if (row?.number !== number || !['OPEN', 'CLOSED', 'MERGED'].includes(row.state)
    || !/^[a-f0-9]{40}$/i.test(row.headRefOid ?? '') || !Number.isFinite(Date.parse(row.updatedAt))
    || typeof row.headRefName !== 'string' || !row.headRefName || typeof row.body !== 'string'
    || ![row.labels, row.files, row.statusCheckRollup].every(Array.isArray)
    || !['mergeable', 'mergeStateStatus', 'reviewDecision', 'baseRefName', 'isDraft'].every(f => Object.hasOwn(row, f))) {
    throw new Error('full PR evidence incomplete');
  }
  return row;
}

const deps = m => [...(m?.blockedBy ?? []), ...(m?.stackParents ?? [])].map(asItemId).filter(isItemId);
const refs = m => (m?.repos ?? []).map(r => r?.ref).filter(Boolean);

/** Conservative undirected closure of the ordering/couple/overlap/card-group edges.
 * Use the ordering layer's item normalizer and the queue's file-completeness/overlap helpers.
 * Ref-only matching deliberately covers the plan-time couple join's ref-only index too.
 */
export function relatedFastDrainPrs(entries, targetKey, groups = []) {
  const connected = (a, b) => {
    const ai = asItemId(a.manifest?.item), bi = asItemId(b.manifest?.item);
    if (isItemId(ai) && isItemId(bi) && (ai === bi || deps(a.manifest).includes(bi) || deps(b.manifest).includes(ai))) return true;
    if (refs(a.manifest).includes(b.p.headRefName) || refs(b.manifest).includes(a.p.headRefName)) return true;
    if (a.repo !== b.repo) return false;
    // Unknown/partial file evidence must not conceal an overlap partner.
    const af = completeListedFiles(a.p.files), bf = completeListedFiles(b.p.files);
    if (!af || !bf || queueFileOverlap({ candidateFiles: af, queuedEntries: [{ files: bf }], includeCards: true }).overlap) return true;
    return groups.some(g => g.repo === a.repo && [g.pr, ...(g.sources ?? []).map(s => s.num)].map(Number).includes(a.p.number)
      && [g.pr, ...(g.sources ?? []).map(s => s.num)].map(Number).includes(b.p.number));
  };
  const selected = new Set([targetKey]);
  const pending = entries.filter(e => fastDrainPrKey(e.repo, e.p.number) === targetKey);
  for (const a of pending) {
    for (const b of entries) {
      const key = fastDrainPrKey(b.repo, b.p.number);
      if (!selected.has(key) && connected(a, b)) { selected.add(key); pending.push(b); }
    }
  }
  selected.delete(targetKey);
  return selected;
}

/** Join the entire bounded read pool before throwing: a failed sibling must not release the
 * pass lock while other reads are still running. Mutations/refreshes stay outside this pool.
 */
export async function readFastDrainFacts(items, concurrency, read) {
  const results = await mapWithConcurrency(items, concurrency, async (item, index) => {
    try { return { value: await read(item, index) }; }
    catch (error) { return { error }; }
  });
  const failed = results.find(r => Object.hasOwn(r, 'error'));
  if (failed) throw failed.error;
  return results.map(r => r.value);
}

/** One base snapshot per catch-up pass, single-flight across child processes. Every reader
 * checks live main SHAs AND revalidates lean PR membership: opening a blocker does not move main.
 * Changed/expired base evidence is refreshed under the shared lock or deferred to the next pass.
 * Rows are published only for the parent's existing snapshotFirst readiness check, not gate authority.
 */
export async function readFastDrainPassInventory({ path, repos, targetRepo, snapshots, readSnapshot = repo => snapshots?.get(repo), readMain,
  listLean, refreshSnapshot = null, concurrency = 4, now = Date.now, write = writeJsonAtomic, env = process.env, log = () => {},
  read = p => { if (statSync(p).size > 64 * 1024 * 1024) throw new Error('pass snapshot oversized'); return JSON.parse(readFileSync(p, 'utf8')); },
  lock = fn => withFastDrainRoundLock(path, fn),
}) {
  const observedAt = now();
  const { seconds: ttlSec, source } = roundSnapshotTtl(env);
  log(`fast-drain: pass snapshot TTL=${ttlSec}s, source=${source}`);
  const fresh = writtenAt => {
    const age = now() - writtenAt;
    return Number.isFinite(age) && age >= 0 && age < ttlSec * 1000;
  };
  if (ttlSec === 0) throw new Error('pass snapshot disabled — use live listing or enable snapshot TTL');
  // `refresh` is only used while BUILDING a new round (never when reusing a published one): a stale
  // cache-only source is refreshed once through the shared single-flight reader; any failure stays fail-closed.
  const readSources = ({ refresh = false, onRefresh = () => {} } = {}) => new Map(repos.map(repo => {
    let rows = readSnapshot(repo);
    if (!Array.isArray(rows) && refresh && typeof refreshSnapshot === 'function') { onRefresh(); rows = refreshSnapshot(repo); }
    if (!Array.isArray(rows)) throw new Error('snapshot unavailable/disabled/stale/dirty — retry next pass');
    return [repo, rows];
  }));
  const readHeads = async () => Object.fromEntries(await readFastDrainFacts(repos, concurrency, async repo => {
    const head = await readMain(repo);
    if (!/^[a-f0-9]{40}$/i.test(head?.sha ?? '') || typeof head.defaultBranch !== 'string' || !head.defaultBranch.trim()) {
      throw new Error('pass main SHA unreadable — retry next pass');
    }
    return [repo, head];
  }));
  let heads = await readHeads();
  const cached = () => {
    try {
      const s = read(path);
      if (s.v !== 1 || s.repo !== targetRepo || !fresh(s.writtenAt)
        || !Array.isArray(s.repos) || s.repos.length !== repos.length || !repos.every(r => s.repos.includes(r))) return null;
      for (const repo of repos) {
        if (s.heads?.[repo]?.sha !== heads[repo].sha || s.heads[repo].defaultBranch !== heads[repo].defaultBranch) return null;
        validateLeanOpenPrs(s.inventories?.[repo], OPEN_PR_LIST_LIMIT, repo);
        if (!Array.isArray(s.snapshots?.[repo])) return null;
      }
      return { writtenAt: s.writtenAt, inventories: new Map(repos.map(r => [r, s.inventories[r]])),
        snapshots: new Map(repos.map(r => [r, s.snapshots[r]])) };
    } catch { return null; }
  };
  const readInventories = async () => new Map(await readFastDrainFacts(repos, concurrency, async repo => {
    const inventory = await listLean(repo);
    validateLeanOpenPrs(inventory, OPEN_PR_LIST_LIMIT, repo);
    return [repo, inventory];
  }));
  const revalidateAfterMembership = async (writtenAt, { refresh = false } = {}) => {
    // Building a new round: concurrent mutations dirty the source within seconds, so the source is re-read through the
    // refresh path FIRST; the main-head and TTL checks below then run after the last (possibly slow) source read.
    const sources = refresh ? readSources({ refresh }) : null;
    const currentHeads = await readHeads();
    if (repos.some(repo => currentHeads[repo].sha !== heads[repo].sha
      || currentHeads[repo].defaultBranch !== heads[repo].defaultBranch)) {
      throw new Error('pass main changed while reading — use live listing or retry next pass');
    }
    if (!fresh(writtenAt)) throw new Error('pass inventory expired while reading — retry next pass');
    // Keep the current cache-only rows: a refreshed source cannot validate older pass evidence.
    return sources ?? readSources();
  };
  // The pass shares base row facts, never membership authority. Fresh head/updatedAt identities
  // also force hydration of new/changed PRs before dependency, couple or overlap gates run.
  const revalidateMembership = async base => {
    const inventories = await readInventories();
    const snapshots = await revalidateAfterMembership(base.writtenAt);
    return { ...base, inventories, snapshots };
  };
  const hit = cached();
  if (hit) return revalidateMembership(hit);
  const result = await lock(async stillHeld => {
    // A main move while waiting for another child invalidates our pre-lock SHA too.
    heads = await readHeads();
    const hit = cached();
    if (hit) return revalidateMembership(hit);
    // Include main-read/lock wait time in the freshness bound. A cold source refresh can itself outlast the TTL and
    // observes nothing the round publishes, so when one ran the bound starts after it, with main re-read after it.
    let refreshed = false;
    readSources({ refresh: true, onRefresh: () => { refreshed = true; } });
    if (refreshed) heads = await readHeads();
    const writtenAt = refreshed ? now() : observedAt;
    const inventories = Object.fromEntries(await readInventories());
    const snapshots = await revalidateAfterMembership(writtenAt, { refresh: true });
    if (typeof stillHeld !== 'function' || !stillHeld()) throw new Error('pass snapshot lock unavailable (lock-lost) — retry next pass');
    write(path, { v: 1, repo: targetRepo, repos, heads, inventories, snapshots: Object.fromEntries(snapshots), writtenAt,
      rows: snapshots.get(targetRepo), defaultBranch: heads[targetRepo].defaultBranch });
    return { inventories: new Map(repos.map(r => [r, inventories[r]])), snapshots };
  });
  if (!result.ok) throw new Error(`pass snapshot unavailable (${result.reason || 'lock failure'}) — retry next pass`);
  return result.value;
}

async function hydrateLiveInventory({ repos, snapshots, target, targetRepo, onlyPr, listLean, readFull, liveReads, concurrency, refreshPr }) {
  const byRepo = new Map();
  await mapWithConcurrency(repos, 1, async repo => {
    const lean = validateLeanOpenPrs(await listLean(repo), OPEN_PR_LIST_LIMIT, repo);
    const snap = new Map(snapshots.get(repo).map(p => [p.number, p]));
    const rows = await readFastDrainFacts(lean, concurrency, async p => {
      let row;
      const isTarget = repo === targetRepo && p.number === Number(onlyPr);
      if (isTarget && matchingSnapshotRow(target, p)) row = target;
      else if (!isTarget && !refreshPr(repo, p) && usableSnapshotRow(snap.get(p.number), p)) row = { ...snap.get(p.number), ...p };
      else {
        row = requireFullPr(await readFull(repo, p.number), p.number);
        liveReads.add(fastDrainPrKey(repo, p.number));
      }
      return row;
    });
    byRepo.set(repo, rows.filter(row => row.state === 'OPEN'));
  });
  return byRepo;
}

async function readManifestEntries(entries, readManifest, concurrency) {
  return new Map(await readFastDrainFacts(entries, concurrency, async ({ repo, p }) =>
    [fastDrainPrKey(repo, p.number), await readManifest(repo, p)]));
}

async function refreshRelatedContext({ byRepo, readGroups, readManifests, targetRepo, onlyPr, readFull, liveReads, concurrency }) {
  const state = await readGroups();
  if (state?.unreadable) throw new Error('card-group state unreadable');
  // Recompute after hydration: a live related row can expose another edge. Each PR is read at most once.
  for (;;) {
    const entries = [];
    for (const [repo, rows] of byRepo) for (const p of rows) entries.push({ repo, p });
    const manifests = await readManifests(entries);
    for (const e of entries) {
      const key = fastDrainPrKey(e.repo, e.p.number);
      if (!manifests.has(key)) throw new Error('manifest evidence incomplete');
      e.manifest = manifests.get(key);
    }
    const related = relatedFastDrainPrs(entries, fastDrainPrKey(targetRepo, onlyPr), state?.groups);
    const pending = entries.filter(e => related.has(fastDrainPrKey(e.repo, e.p.number)) && !liveReads.has(fastDrainPrKey(e.repo, e.p.number)));
    if (!pending.length) break;
    await readFastDrainFacts(pending, concurrency, async ({ repo, p }) => {
      const live = requireFullPr(await readFull(repo, p.number), p.number);
      liveReads.add(fastDrainPrKey(repo, p.number));
      byRepo.set(repo, byRepo.get(repo).flatMap(row => row.number !== p.number ? [row] : live.state === 'OPEN' ? [live] : []));
    });
  }
}

/** Complete per-repo context, or defer catch-up. Legacy callers may opt into the full-list fallback. */
export async function readFastDrainContext({ repos, targetRepo, onlyPr, readSnapshot, listLean, readFull,
  readManifest, concurrency = 4, readInventory, failClosed = false, refreshPr = () => false,
  readManifests = entries => readManifestEntries(entries, readManifest, concurrency),
  readGroups = () => ({ groups: [] }), time = (_phase, f) => f(), log = () => {} }) {
  try {
    const loadInventory = () => {
      if (readInventory) return readInventory();
      const snapshots = new Map(repos.map(repo => {
        const rows = readSnapshot(repo);
        if (!Array.isArray(rows)) throw new Error('snapshot unavailable/disabled/stale/dirty');
        return [repo, rows];
      }));
      return { snapshots };
    };
    // Pass reuse is cache-only and must retain the source snapshot's freshness checks.
    const readTarget = () => time('listing.target', async () => requireFullPr(await readFull(targetRepo, Number(onlyPr)), Number(onlyPr)));
    let base, target;
    if (readInventory) [base, target] = await readFastDrainFacts(
      [() => time('listing.inventory', loadInventory), readTarget], 2, read => read());
    else { base = loadInventory(); target = await readTarget(); }
    const { snapshots, inventories } = base;
    const liveReads = new Set([fastDrainPrKey(targetRepo, onlyPr)]);
    const byRepo = await time('listing.lean', () => hydrateLiveInventory({ repos, snapshots, target, targetRepo, onlyPr, listLean: inventories ? repo => inventories.get(repo) : listLean, readFull, liveReads, concurrency, refreshPr }));
    await time('listing.related', () => refreshRelatedContext({ byRepo, readGroups, readManifests, targetRepo, onlyPr, readFull, liveReads, concurrency }));
    return byRepo;
  } catch (e) {
    const reason = String(e?.message ?? e).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 180);
    if (failClosed) throw new Error(`fast-drain: incomplete pass context (${reason}) — retry next pass`, { cause: e });
    log(`fast-drain: context fell back to full listing (${reason})`);
    return null;
  }
}

/** Load cheap branch hints before listing. Live merge authorization must wait until pages finish. */
export async function fastDrainListingAfterBranches({ resolveBranches, list }) {
  await resolveBranches();
  return list();
}
