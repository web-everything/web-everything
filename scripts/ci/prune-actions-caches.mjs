#!/usr/bin/env node
/**
 * prune-actions-caches: prune obsolete GitHub Actions caches.
 *
 * CodeQL default setup writes a ~1.7 GB `codeql-overlay-base-database-...` cache
 * on every main push; only the newest one per (ref, language) is useful. This
 * deletes the older overlays plus non-npm caches that belong to closed PR refs.
 * npm `node-cache-*` caches are always kept. Malformed cache records are skipped;
 * bad enumeration responses, invalid timestamps on any remaining record, or
 * missing open-PR evidence block the entire batch before any DELETE.
 *
 * Usage: node scripts/ci/prune-actions-caches.mjs [--apply] [--repo=owner/name]
 *   --require-candidates: fail if no pruning candidate is found (live dry-run gate).
 *   --verify-acceptance: after --apply, assert usage < 4 GB and all pre-run npm IDs
 *     remain. A failed check needs operator inspection; retention alone cannot
 *     guarantee a byte budget, and concurrent expiry/eviction can remove npm IDs.
 * Default is a dry run. Uses the `gh` CLI (GH_BIN overrides the binary, for tests).
 */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// schema-componentsHash-language-CodeQLVersion-commit-runId-attempt
const OVERLAY = /^codeql-overlay-base-database-\d+-[0-9a-f]{16}-(?<lang>[a-z][a-z0-9+-]*?)-\d+\.\d+\.\d+(?:-[0-9a-z.]+)?-[0-9a-f]{40}-\d+-\d+(?![\s\S])/i;

export function overlayLanguage(key) {
  const m = OVERLAY.exec(String(key));
  return m ? m.groups.lang.toLowerCase() : null;
}

const prNumber = (ref) => {
  const m = /^refs\/pull\/(\d+)\//.exec(String(ref));
  return m ? Number(m[1]) : null;
};

const validCache = (c) =>
  c && Number.isInteger(c.id) && typeof c.key === 'string' && typeof c.ref === 'string';
const time = (c) => Date.parse(c.created_at);

/**
 * @param {Array<{id:number,key:string,ref:string,created_at:string}>} caches
 * @param {Set<number>|null} openPrs open PR numbers; null/absent means unknown,
 *   so no cache is deleted (fail closed).
 * @returns {Array<{id:number,key:string,reason:string}>}
 */
export function selectCachesToDelete(caches, openPrs = null) {
  const out = [];
  const list = caches.filter(validCache);
  if (!(openPrs instanceof Set) || list.some((c) => !Number.isFinite(time(c)))) return [];
  const newest = new Map();
  for (const c of list) {
    const lang = overlayLanguage(c.key);
    if (!lang) continue;
    const k = `${c.ref}\n${lang}`;
    const cur = newest.get(k);
    if (!cur || time(c) > time(cur)) newest.set(k, c);
  }
  for (const c of list) {
    if (c.key.startsWith('node-cache-')) continue;
    const pr = prNumber(c.ref);
    if (pr !== null) {
      if (!openPrs.has(pr)) out.push({ id: c.id, key: c.key, reason: `closed PR #${pr}` });
      if (!overlayLanguage(c.key) || !openPrs.has(pr)) continue;
    }
    const lang = overlayLanguage(c.key);
    if (!lang) continue;
    if (newest.get(`${c.ref}\n${lang}`).id !== c.id) {
      out.push({ id: c.id, key: c.key, reason: `older codeql overlay (${lang}) on ${c.ref}` });
    }
  }
  return out;
}

const GH = process.env.GH_BIN || 'gh';
function gh(args) {
  const r = spawnSync(GH, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`gh ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

export function parseCaches(raw) {
  const pages = JSON.parse(raw);
  if (!Array.isArray(pages) || !pages.length) throw new Error('caches response is not a nonempty array of pages');
  return pages.flatMap((p) => {
    if (!p || !Array.isArray(p.actions_caches)) throw new Error('page without actions_caches');
    return p.actions_caches;
  });
}

export function parseOpenPrs(raw) {
  const pages = JSON.parse(raw);
  if (!Array.isArray(pages) || !pages.length || pages.some((p) => !Array.isArray(p))) {
    throw new Error('pulls response is not a nonempty array of array pages');
  }
  const nums = pages.flat().map((p) => p?.number);
  if (nums.some((n) => !Number.isInteger(n))) throw new Error('pull record without a numeric number');
  return new Set(nums);
}

function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const verifyAcceptance = argv.includes('--verify-acceptance');
  if (verifyAcceptance && !apply) throw new Error('--verify-acceptance requires --apply');
  const repo = (argv.find((a) => a.startsWith('--repo=')) || '').slice(7) || process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('--repo=owner/name or GITHUB_REPOSITORY required');
  const caches = parseCaches(gh(['api', '--paginate', '--slurp', `repos/${repo}/actions/caches?per_page=100`]));
  const open = parseOpenPrs(gh(['api', '--paginate', '--slurp', `repos/${repo}/pulls?state=open&per_page=100`]));
  if (caches.filter(validCache).some((c) => !Number.isFinite(time(c)))) throw new Error('Invalid cache timestamp; no caches deleted');
  const doomed = selectCachesToDelete(caches, open);
  if (argv.includes('--require-candidates') && !doomed.length) throw new Error('No pruning candidates; inspect the live cache inventory');
  for (const d of doomed) {
    console.log(`${apply ? 'delete' : 'would delete'} ${d.id} ${d.key} (${d.reason})`);
    if (apply) gh(['api', '-X', 'DELETE', `repos/${repo}/actions/caches/${d.id}`]);
  }
  console.log(`${doomed.length} of ${caches.length} caches ${apply ? 'deleted' : 'selected (dry run)'}`);
  if (verifyAcceptance) {
    const after = parseCaches(gh(['api', '--paginate', '--slurp', `repos/${repo}/actions/caches?per_page=100`]));
    const usage = JSON.parse(gh(['api', `repos/${repo}/actions/cache/usage`]));
    const bytes = usage?.active_caches_size_in_bytes;
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes >= 4_000_000_000) {
      throw new Error('Acceptance failed: cache usage must be known and below 4000000000 bytes; inspect retained caches');
    }
    const npmIds = caches.filter(validCache).filter((c) => c.key.startsWith('node-cache-')).map((c) => c.id);
    const remaining = new Set(after.filter(validCache).map((c) => c.id));
    if (npmIds.some((id) => !remaining.has(id))) throw new Error('Acceptance failed: pre-run npm cache IDs missing; inspect eviction/expiry');
    console.log(`Acceptance passed: ${bytes} bytes < 4000000000; all ${npmIds.length} npm cache IDs remain`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
}
