/**
 * Single green-event drain context. The live, lean inventory owns membership; a cache-only
 * shared snapshot contributes full rows only at the same number/head/updatedAt. Unknown
 * inventory or evidence falls back to the drain's existing full listing. Related components
 * are refreshed before returning any evidence to gates; none of the merge gates lives here.
 * IO is injected so cost, freshness, fallback and ordering can be exercised without GitHub.
 */
import { asItemId, isItemId } from '../readiness/lane-manifest.mjs';
import { isDegradedOpenPrListing, OPEN_PR_LIST_LIMIT } from './no-search-backed-pr-list.mjs';
import { assertInventoryComplete, buildOpenPrPageQuery, parseOpenPrPage } from './pr-list-paged.mjs';
import { queueFileOverlap, completeListedFiles } from './queue-file-overlap.mjs';

export const LEAN_OPEN_PR_FIELDS = 'number,headRefOid,updatedAt,baseRefName,isDraft,state';
export const fastDrainPrKey = (repo, number) => `${repo}#${number}`;

export function useFastDrainContext({ onlyPr, fromGreenEvent, onlyRepo, localSlug, listing, context }) {
  return onlyPr != null && !!fromGreenEvent && (!onlyRepo || onlyRepo === localSlug) && !!localSlug
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

async function hydrateLiveInventory({ repos, snapshots, target, targetRepo, onlyPr, listLean, readFull, liveReads }) {
  const byRepo = new Map();
  for (const repo of repos) {
    const lean = validateLeanOpenPrs(await listLean(repo), OPEN_PR_LIST_LIMIT, repo);
    const snap = new Map(snapshots.get(repo).map(p => [p.number, p]));
    const rows = [];
    for (const p of lean) {
      let row;
      const isTarget = repo === targetRepo && p.number === Number(onlyPr);
      if (isTarget && matchingSnapshotRow(target, p)) row = target;
      else if (!isTarget && usableSnapshotRow(snap.get(p.number), p)) row = { ...snap.get(p.number), ...p };
      else {
        row = requireFullPr(await readFull(repo, p.number), p.number);
        liveReads.add(fastDrainPrKey(repo, p.number));
      }
      if (row.state === 'OPEN') rows.push(row);
    }
    byRepo.set(repo, rows);
  }
  return byRepo;
}

async function readManifestEntries(entries, readManifest) {
  const manifests = new Map();
  for (const { repo, p } of entries) manifests.set(fastDrainPrKey(repo, p.number), await readManifest(repo, p));
  return manifests;
}

async function refreshRelatedContext({ byRepo, readGroups, readManifests, targetRepo, onlyPr, readFull, liveReads }) {
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
    for (const { repo, p } of pending) {
      const live = requireFullPr(await readFull(repo, p.number), p.number);
      liveReads.add(fastDrainPrKey(repo, p.number));
      byRepo.set(repo, byRepo.get(repo).flatMap(row => row.number !== p.number ? [row] : live.state === 'OPEN' ? [live] : []));
    }
  }
}

/** Either return a complete per-repo row map or null: the caller then runs its old full path. */
export async function readFastDrainContext({ repos, targetRepo, onlyPr, readSnapshot, listLean, readFull,
  readManifest, readManifests = entries => readManifestEntries(entries, readManifest),
  readGroups = () => ({ groups: [] }), time = (_phase, f) => f(), log = () => {} }) {
  try {
    const snapshots = new Map();
    for (const repo of repos) {
      const rows = readSnapshot(repo);
      if (!Array.isArray(rows)) throw new Error('snapshot unavailable/disabled/stale/dirty');
      snapshots.set(repo, rows);
    }
    const target = requireFullPr(await time('listing.target', () => readFull(targetRepo, Number(onlyPr))), Number(onlyPr));
    const liveReads = new Set([fastDrainPrKey(targetRepo, onlyPr)]);
    const byRepo = await time('listing.lean', () => hydrateLiveInventory({ repos, snapshots, target, targetRepo, onlyPr, listLean, readFull, liveReads }));
    await time('listing.related', () => refreshRelatedContext({ byRepo, readGroups, readManifests, targetRepo, onlyPr, readFull, liveReads }));
    return byRepo;
  } catch (e) {
    const reason = String(e?.message ?? e).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 180);
    log(`fast-drain: context fell back to full listing (${reason})`);
    return null;
  }
}

/** Load cheap branch hints before listing. Live merge authorization must wait until pages finish. */
export async function fastDrainListingAfterBranches({ resolveBranches, list }) {
  await resolveBranches();
  return list();
}
