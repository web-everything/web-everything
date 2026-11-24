#!/usr/bin/env node
/**
 * prune-actions-caches: keep the GitHub Actions cache under its 10 GB limit.
 *
 * CodeQL default setup writes a ~1.7 GB `codeql-overlay-base-database-...` cache
 * on every main push; only the newest one per language is useful. This deletes
 * the older overlays plus caches that belong to closed PR refs. It never selects
 * anything else (npm caches `node-cache-*` etc. are always kept).
 *
 * Usage: node scripts/ci/prune-actions-caches.mjs [--apply] [--repo=owner/name]
 * Default is a dry run. Uses the `gh` CLI (GH_TOKEN in CI).
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

/**
 * @param {Array<{id:number,key:string,ref:string,created_at:string}>} caches
 * @param {Set<number>} openPrs open PR numbers (caches of other PR refs are closed-PR caches)
 * @returns {Array<{id:number,key:string,reason:string}>}
 */
export function selectCachesToDelete(caches, openPrs = new Set()) {
  const out = [];
  const newest = new Map();
  for (const c of caches) {
    const lang = overlayLanguage(c.key);
    if (!lang) continue;
    const cur = newest.get(lang);
    if (!cur || Date.parse(c.created_at) > Date.parse(cur.created_at)) newest.set(lang, c);
  }
  for (const c of caches) {
    const lang = overlayLanguage(c.key);
    if (lang) {
      if (newest.get(lang).id !== c.id) out.push({ id: c.id, key: c.key, reason: `older codeql overlay (${lang})` });
      continue;
    }
    const pr = prNumber(c.ref);
    if (pr !== null && !openPrs.has(pr) && !String(c.key).startsWith('node-cache-')) {
      out.push({ id: c.id, key: c.key, reason: `closed PR #${pr}` });
    }
  }
  return out;
}

function gh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`gh ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const repo = (argv.find((a) => a.startsWith('--repo=')) || '').slice(7) || process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('--repo=owner/name or GITHUB_REPOSITORY required');
  const caches = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/actions/caches?per_page=100`]))
    .flatMap((p) => p.actions_caches || []);
  const open = new Set(
    JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/pulls?state=open&per_page=100`]))
      .flat().map((p) => p.number),
  );
  const doomed = selectCachesToDelete(caches, open);
  for (const d of doomed) {
    console.log(`${apply ? 'delete' : 'would delete'} ${d.id} ${d.key} (${d.reason})`);
    if (apply) gh(['api', '-X', 'DELETE', `repos/${repo}/actions/caches/${d.id}`]);
  }
  console.log(`${doomed.length} of ${caches.length} caches ${apply ? 'deleted' : 'selected (dry run)'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
