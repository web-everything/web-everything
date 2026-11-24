#!/usr/bin/env node
/**
 * prune-actions-caches: keep the GitHub Actions cache under its 10 GB limit.
 *
 * CodeQL default setup writes a ~1.7 GB `codeql-overlay-base-database-...` cache
 * on every main push; only the newest one per (ref, language) is useful. This
 * deletes the older overlays plus caches that belong to closed PR refs. It never
 * selects anything else (npm `node-cache-*` etc. are always kept). It fails
 * closed: bad input, bad timestamps or missing open-PR evidence delete nothing.
 *
 * Usage: node scripts/ci/prune-actions-caches.mjs [--apply] [--repo=owner/name]
 * Default is a dry run. Uses the `gh` CLI (GH_BIN overrides the binary, for tests).
 */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const OVERLAY = /^codeql-overlay-base-database-.*-(?<lang>[a-z+-]+)$/i;

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
 *   so no PR-ref cache is deleted (fail closed).
 * @returns {Array<{id:number,key:string,reason:string}>}
 */
export function selectCachesToDelete(caches, openPrs = null) {
  const out = [];
  const known = openPrs instanceof Set;
  const list = caches.filter(validCache);
  const newest = new Map();
  for (const c of list) {
    const lang = overlayLanguage(c.key);
    if (!lang || !Number.isFinite(time(c))) continue;
    const k = `${c.ref}\n${lang}`;
    const cur = newest.get(k);
    if (!cur || time(c) > time(cur)) newest.set(k, c);
  }
  for (const c of list) {
    if (c.key.startsWith('node-cache-')) continue;
    const pr = prNumber(c.ref);
    if (pr !== null) {
      if (known && !openPrs.has(pr)) out.push({ id: c.id, key: c.key, reason: `closed PR #${pr}` });
      if (!known || !overlayLanguage(c.key) || !openPrs.has(pr)) continue;
    }
    const lang = overlayLanguage(c.key);
    if (!lang || !Number.isFinite(time(c))) continue;
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
  if (!Array.isArray(pages)) throw new Error('caches response is not an array of pages');
  return pages.flatMap((p) => {
    if (!p || !Array.isArray(p.actions_caches)) throw new Error('page without actions_caches');
    return p.actions_caches;
  });
}

export function parseOpenPrs(raw) {
  const pages = JSON.parse(raw);
  if (!Array.isArray(pages)) throw new Error('pulls response is not an array of pages');
  const nums = pages.flat().map((p) => p?.number);
  if (nums.some((n) => !Number.isInteger(n))) throw new Error('pull record without a numeric number');
  return new Set(nums);
}

function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const repo = (argv.find((a) => a.startsWith('--repo=')) || '').slice(7) || process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('--repo=owner/name or GITHUB_REPOSITORY required');
  const caches = parseCaches(gh(['api', '--paginate', '--slurp', `repos/${repo}/actions/caches?per_page=100`]));
  const open = parseOpenPrs(gh(['api', '--paginate', '--slurp', `repos/${repo}/pulls?state=open&per_page=100`]));
  const doomed = selectCachesToDelete(caches, open);
  for (const d of doomed) {
    console.log(`${apply ? 'delete' : 'would delete'} ${d.id} ${d.key} (${d.reason})`);
    if (apply) gh(['api', '-X', 'DELETE', `repos/${repo}/actions/caches/${d.id}`]);
  }
  console.log(`${doomed.length} of ${caches.length} caches ${apply ? 'deleted' : 'selected (dry run)'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
}
