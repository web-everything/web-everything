/**
 * @file scripts/lib/salvage-index.mjs
 * @description The READ side of lane salvage (`we:scripts/lib/lane-salvage.mjs`): a backup nobody looks at is
 *   useless, so the index is what makes salvaged work findable and self-cleaning.
 *
 *   - {@link salvageHintFor} / {@link withSalvageHint}: when a dispatcher starts a session for a card or PR that
 *     has a NOT-landed salvage entry, the brief gets one line pointing at it.
 *   - {@link refreshSalvageIndex}: marks an entry `landed` once its salvaged content is already on
 *     `origin/<branch>` (needs no attention), and EXPIRES entries (files, refs, index row) older than 14 days.
 *   - {@link backfillSalvageDir}: indexes a salvage made by hand (the operator's 2026-09-26 21:36/21:42 ET runs,
 *     `<root>/<stamp>/lane-N.{bundle,uncommitted.patch,unpushed.txt,untracked.txt}`).
 *
 * The index is `<salvageRoot>/index.jsonl`; every rewrite runs under `withFileLock` so a concurrent salvage's
 * append is never lost.
 */
import { isUnderTest } from './under-test.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, lstatSync, realpathSync, writeFileSync, renameSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { withFileLock } from './atomic-json-file.mjs';
import { resolveSalvageRoot, salvageIndexPath, deriveSalvageTargets, SALVAGE_DIR_ENV } from './lane-salvage.mjs';

export const SALVAGE_RETENTION_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

const git = (dir, args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
const tryGit = (dir, args) => { try { return git(dir, args); } catch { return null; } };

/** Tolerant jsonl read — a torn/corrupt line is skipped, never thrown. */
export function readSalvageIndex(root = resolveSalvageRoot()) {
  const p = salvageIndexPath(root);
  if (!existsSync(p)) return [];
  const out = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip a torn line */ }
  }
  return out;
}

/** Rewrite the index under its lock: `mutate(entries) → entries`. */
export function updateSalvageIndex(root, mutate) {
  const p = salvageIndexPath(root);
  return withFileLock(`${p}.lock`, () => {
    const next = mutate(readSalvageIndex(root));
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, next.map((e) => JSON.stringify(e)).join('\n') + (next.length ? '\n' : ''));
    renameSync(tmp, p);
    return next;
  });
}

/** PURE: the not-landed entries for any of these card ids / PR numbers, newest first. */
export function salvageEntriesFor(entries, { cards = [], prs = [] } = {}) {
  const c = new Set(cards.filter((x) => x != null && x !== '').map((x) => String(x).toLowerCase()));
  const p = new Set(prs.map(Number).filter(Number.isInteger));
  if (!c.size && !p.size) return [];
  return entries
    .filter((e) => e && !e.landed && !e.expired
      && ((e.cards || []).some((x) => c.has(String(x).toLowerCase())) || (e.prs || []).some((x) => p.has(Number(x)))))
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
}

/** PURE: the one brief line, or `null`. */
export function salvageHintLine(matches) {
  if (!matches.length) return null;
  const where = matches.map((e) => e.bundle || e.outDir).filter(Boolean);
  return `Earlier unfinished work for this item was salvaged at ${where.join(', ')} — inspect/reuse before starting over ` +
    `(\`git fetch <bundle> 'refs/salvage/*:refs/salvage/*'\`, or apply the .uncommitted.patch next to it).`;
}

/** IO: the hint for a dispatch, never throwing (a dispatch must not fail over a hint). */
export function salvageHintFor({ cards = [], prs = [], root = null, env = process.env } = {}) {
  // Under vitest, never read the operator's REAL salvage store unless a test points at one explicitly.
  if (!root && isUnderTest(env) && !env[SALVAGE_DIR_ENV]) return null;
  root = root || resolveSalvageRoot(env);
  try { return salvageHintLine(salvageEntriesFor(readSalvageIndex(root), { cards, prs })); } catch { return null; }
}

/** IO: append the hint to a prompt when there is one. */
export function withSalvageHint(prompt, { cards = [], prs = [], root } = {}) {
  if (typeof prompt !== 'string' || !prompt) return prompt;
  const hint = salvageHintFor({ cards, prs, ...(root ? { root } : {}) });
  return hint ? `${prompt}\n\n${hint}\n` : prompt;
}

/**
 * Is every salvaged snapshot's content already on `branchRef`? Per snapshot tip (wip, else head): the files it
 * changed vs its merge-base must be identical on `branchRef`. Needs the objects: fetched from the bundle into
 * `repoDir` when missing. Returns `null` when it cannot tell (no repo, no bundle).
 */
export function isSalvageLanded(entry, { repoDir, branchRef = 'origin/main' }) {
  if (!repoDir || !existsSync(repoDir)) return null;
  const tips = (entry.snapshots || []).map((s) => s.wipSha || s.headSha).filter(Boolean);
  if (!tips.length) return null;
  const missing = tips.some((t) => tryGit(repoDir, ['cat-file', '-e', `${t}^{commit}`]) === null);
  if (missing) {
    if (!entry.bundle || !existsSync(entry.bundle)) return null;
    if (tryGit(repoDir, ['fetch', '-q', entry.bundle, 'refs/salvage/*:refs/salvage/*']) === null) return null;
  }
  const covered = new Set();
  for (const tip of tips) {
    const base = tryGit(repoDir, ['merge-base', branchRef, tip]);
    if (!base) return null;
    const files = (tryGit(repoDir, ['diff', '--name-only', base.trim(), tip]) || '').split('\n').filter(Boolean);
    if (!files.length) continue;
    const diff = tryGit(repoDir, ['diff', '--name-only', branchRef, tip, '--', ...files]);
    if (diff === null) return null;
    if (diff.trim()) return false;
    for (const f of files) covered.add(f);
  }
  // A file the entry lists as changed but no tip carries (e.g. an untracked file held only in a `git stash`'s
  // third parent, from a hand-made salvage) cannot be proven landed — say "unknown", never "landed".
  if ((entry.changedFiles || []).some((f) => !covered.has(f))) return null;
  return covered.size > 0 ? true : null;
}

/**
 * Host churn cut (2026-10-04) — `isSalvageLanded` is a function of the entry's snapshot tips and the branch
 * tip it is compared against, so a "not landed" verdict stays true until that lane's `origin/main` moves. Every
 * health-watch pass (×3 pools, sharing ONE salvage index) used to re-run cat-file + merge-base + 2× diff for
 * every one of ~300 unlanded entries — ~1,400 `git` children per pass, all under the index lock. Now each entry
 * records the branch tip it was last judged against (`landedCheck`) and is re-judged only when that tip moves
 * (or its snapshots change). The memo can only DELAY a "landed" mark, never invent one: a cached verdict is
 * never `true` (a landed entry is marked and leaves this path). Env `WE_SALVAGE_LANDED_MEMO=0` disables it.
 */
export const SALVAGE_LANDED_MEMO_ENV = 'WE_SALVAGE_LANDED_MEMO';
export function resolveLandedMemoEnabled(env = process.env) { return env[SALVAGE_LANDED_MEMO_ENV] !== '0'; }

/** PURE: the memo key — branch tip + the exact tips judged, so a changed snapshot list is never a stale hit. */
export function landedCheckKey(entry, branchSha) {
  const tips = (entry.snapshots || []).map((s) => s.wipSha || s.headSha).filter(Boolean);
  return `${branchSha}:${tips.join(',')}`;
}

/** The branch tip SHA in `dir` — plain fs read of the ref (loose, then packed-refs); `git rev-parse` fallback. */
export function branchShaReader(branchRef) {
  const m = /^origin\/(.+)$/.exec(branchRef);
  const refName = m ? `refs/remotes/origin/${m[1]}` : null;
  return (dir) => {
    if (refName) {
      try {
        const v = readFileSync(join(dir, '.git', refName), 'utf8').trim();
        if (/^[0-9a-f]{40,64}$/.test(v)) return v;
      } catch { /* not loose — try packed-refs */ }
      try {
        for (const line of readFileSync(join(dir, '.git', 'packed-refs'), 'utf8').split('\n')) {
          const [sha, name] = line.trim().split(' ');
          if (name === refName && /^[0-9a-f]{40,64}$/.test(sha)) return sha;
        }
      } catch { /* no packed-refs */ }
    }
    const out = tryGit(dir, ['rev-parse', '--verify', '--quiet', `${branchRef}^{commit}`]);
    return out ? out.trim() : null;
  };
}

/** PURE: parse a salvage stamp (`20260926-2136` or `20260927-015411`) as UTC ms; `null` if unparsable. */
export function parseSalvageStamp(stamp) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})?$/.exec(String(stamp || ''));
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
}

/**
 * Mark landed entries, expire old ones. Expiry deletes the entry's files, its `refs/salvage/*` in its lane (when
 * the lane still exists), its now-empty stamp dir, and the index row. `dryRun` reports without changing anything.
 * @returns {{landed:object[], expired:object[], bytesFreed:number, kept:number}}
 */
export function refreshSalvageIndex({ root = resolveSalvageRoot(), branchRef = 'origin/main', nowMs = Date.now(), retentionDays = SALVAGE_RETENTION_DAYS, dryRun = false, repoDirFor = (e) => e.dir, memo = resolveLandedMemoEnabled(), branchShaFor = branchShaReader(branchRef), isLanded = isSalvageLanded } = {}) {
  const landed = []; const expired = []; let bytesFreed = 0;
  const shaByDir = new Map(); // one branch-tip read per lane dir per refresh, however many entries share it
  const tipFor = (dir) => {
    if (!shaByDir.has(dir)) { let sha = null; try { sha = branchShaFor(dir); } catch { sha = null; } shaByDir.set(dir, sha); }
    return shaByDir.get(dir);
  };
  const cutoff = nowMs - retentionDays * DAY_MS;
  const decide = (entries) => {
    const keep = [];
    for (const e of entries) {
      const t = Date.parse(e.ts) || parseSalvageStamp(e.stamp) || nowMs;
      if (t < cutoff) {
        // #4273: only stat/size paths genuinely under the salvage root — same containment rule
        // `deleteEntryArtifacts` enforces for the actual removal, applied here too so a tampered
        // out-of-root path is never even walked. DEDUPE `plain` against `globbed` first — `bundle`/`patches`
        // sit inside `outDir` too, so the `lane-N.` glob ALSO finds them; summing both sets un-deduped would
        // double-count every such file's bytes (review finding: correctness/claim-accuracy, this round).
        const { plain, globbed } = entryFiles(e);
        for (const f of new Set([...plain, ...globbed])) { if (isUnderSalvageRoot(f, root)) { try { bytesFreed += pathSize(f); } catch { /* gone */ } } }
        expired.push(e);
        continue;
      }
      if (!e.landed) {
        const repoDir = repoDirFor(e);
        const branchSha = memo && repoDir && existsSync(repoDir) ? tipFor(repoDir) : null;
        const key = branchSha ? landedCheckKey(e, branchSha) : null;
        if (!(key && e.landedCheck === key)) {
          const ok = isLanded(e, { repoDir, branchRef });
          if (ok === true) { landed.push(e); e.landed = true; e.landedAt = new Date(nowMs).toISOString(); delete e.landedCheck; }
          else if (key) e.landedCheck = key; // "not provably landed against THIS branch tip" — re-checked once it moves
        }
      }
      keep.push(e);
    }
    return keep;
  };
  if (dryRun) {
    decide(readSalvageIndex(root).map((e) => ({ ...e })));
  } else if (existsSync(salvageIndexPath(root))) {
    updateSalvageIndex(root, decide);
    for (const e of expired) deleteEntryArtifacts(e, root);
  }
  return { landed, expired, bytesFreed, kept: readSalvageIndex(root).length };
}

/** Splits an entry's removable paths into two sets with DIFFERENT removal rules (#4273 review — narrowing the
 *  blast radius of the recursive delete a `litter` copy forced in):
 *  - `plain`: `bundle` + `patches` — files `salvageLane` itself always writes as plain FILES, never a
 *    directory. Removed NON-recursively, exactly as before this module ever supported `litter` — an
 *    index-supplied `bundle`/`patches` entry that turned out to BE a directory (tampered or corrupt) simply
 *    fails to remove (as it always has), never recursively deletes a whole tree.
 *  - `globbed`: every OTHER `lane-${lane}.*`-prefixed entry actually sitting in `outDir` — this is where a
 *    directory-shaped artifact (`lane-N.wt-litter`, a `litter` copy) lives, so recursive removal is scoped to
 *    ONLY this glob-derived set, never to an index-supplied `bundle`/`patches` path.
 *  `e.litter[].dest` paths are deliberately not read from the index row at all here: they are nested INSIDE
 *  the `lane-N.wt-litter` directory the glob already finds, so re-adding them would double-count their bytes
 *  in `pathSize` and be redundant for `rmSync` (removing the parent directory already removes them). */
function entryFiles(e) {
  const plain = new Set([e.bundle, ...(e.patches || [])].filter(Boolean));
  const globbed = new Set();
  if (e.outDir && existsSync(e.outDir)) {
    for (const f of readdirSync(e.outDir)) if (f.startsWith(`lane-${e.lane}.`)) globbed.add(join(e.outDir, f));
  }
  return { plain: [...plain], globbed: [...globbed] };
}

/** A path's total size on disk — recurses into a directory (e.g. a `litter` copy) instead of reporting just
 *  its own directory-entry size, so `bytesFreed` (#4273) is not silently undercounted for one. Uses
 *  `lstatSync`, NEVER `statSync`, and never recurses into a symlink: a `litter` copy can itself contain a
 *  symlink (salvage preserves one verbatim, never dereferencing it — see `lane-salvage.mjs`), and following one
 *  here during expiry accounting could count bytes that were never actually copied, or loop on a self- /
 *  ancestor-referential link. A symlink's OWN (small) size is all this ever reports for one. */
function pathSize(p) {
  let total = 0;
  const st = lstatSync(p);
  if (st.isSymbolicLink() || !st.isDirectory()) return st.size;
  for (const name of readdirSync(p)) { try { total += pathSize(join(p, name)); } catch { /* gone */ } }
  return total;
}

/** Resolve to a REAL path when it exists (so a symlink can never route a comparison around it), falling back
 *  to a plain lexical resolve for a path that is already gone (expiry must still be able to reason about — and
 *  skip cleanly past — something a previous run already removed). */
function realOrResolved(p) {
  try { return realpathSync(p); } catch { return resolve(p); }
}

/** Is `p` STRICTLY inside the salvage root — never the root itself? A path-containment check (#4273 review) —
 *  every path this module deletes comes from an index row it also trusts for its filename `lane-${lane}.`
 *  prefix glob, so a corrupted/hand-edited `index.jsonl` whose `bundle`/`patches`/`outDir` points AT or OUTSIDE
 *  the salvage root must never let expiry `rmSync` (recursively, for a `litter` directory) whatever is there.
 *  `rp === r` is DELIBERATELY not accepted (a legitimate `bundle`/`patches`/`litter[].dest` is always nested
 *  under `<root>/<pool>/<stamp>/…`, never the root itself), and both sides resolve through `realOrResolved` so
 *  a symlink planted inside a legitimate `outDir` cannot resolve OUT of the root and still pass. */
export function isUnderSalvageRoot(p, root) {
  const r = realOrResolved(root);
  const rp = realOrResolved(p);
  return rp !== r && rp.startsWith(r + sep);
}

function deleteEntryArtifacts(e, root) {
  const { plain, globbed } = entryFiles(e);
  // `plain` (bundle/patches) is what `salvageLane` always writes as ordinary FILES — never recursive, exactly
  // as this module behaved before `litter` existed. A NON-recursive `rmSync` on a path that turns out to BE a
  // directory (a tampered/legacy row) THROWS (`EISDIR`) rather than quietly no-op-ing — `force` only suppresses
  // a MISSING path, never a wrong-type one — so this is wrapped: one bad entry must never abort expiry for
  // every OTHER entry in the same batch (matches this function's own outDir-cleanup below, already wrapped).
  // It never recursively deletes a whole tree either way — it just sometimes fails to remove at all.
  for (const f of plain) { if (isUnderSalvageRoot(f, root)) { try { rmSync(f, { force: true }); } catch { /* wrong type (e.g. a directory) or a race — leave it, keep going */ } } }
  // `globbed` is where a `litter` copy's directory (`lane-N.wt-litter`) lives — recursive removal is scoped to
  // ONLY this glob-derived set, per `entryFiles`'s docblock.
  for (const f of globbed) { if (isUnderSalvageRoot(f, root)) { try { rmSync(f, { recursive: true, force: true }); } catch { /* leave it, keep going */ } } }
  if (e.outDir && existsSync(e.outDir)) { try { if (!readdirSync(e.outDir).length) rmSync(e.outDir, { recursive: true }); } catch { /* keep */ } }
  if (e.dir && existsSync(e.dir)) {
    // Every ref this salvage made, including ones an older index row did not list (`refs/salvage/lane-N-<stamp>-*`).
    const byPrefix = e.lane != null && e.stamp
      ? (tryGit(e.dir, ['for-each-ref', '--format=%(refname)', `refs/salvage/lane-${e.lane}-${e.stamp}-*`]) || '').split('\n').filter(Boolean)
      : [];
    for (const r of new Set([...(e.refs || []), ...(e.localRefs || []), ...byPrefix])) tryGit(e.dir, ['update-ref', '-d', r]);
  }
}

/**
 * Index a hand-made salvage dir (`<dir>/lane-N.bundle` + siblings) that has no index rows yet. Idempotent: a
 * bundle already indexed is skipped. `laneDirFor(n)` gives the lane path (for its history ledger + refs).
 * @returns {object[]} the rows added
 */
export function backfillSalvageDir({ dir, pool, root = resolveSalvageRoot(), laneDirFor = () => null, readLastHolder = () => null, now = new Date() }) {
  if (!existsSync(dir)) return [];
  const stamp = basename(dir);
  const known = new Set(readSalvageIndex(root).map((e) => e.bundle).filter(Boolean));
  const rows = [];
  for (const f of readdirSync(dir).filter((x) => /^lane-\d+\.bundle$/.test(x)).sort()) {
    const bundle = join(dir, f);
    if (known.has(bundle)) continue;
    const lane = Number(/^lane-(\d+)\./.exec(f)[1]);
    const laneDir = laneDirFor(lane);
    const headsText = tryGit(laneDir && existsSync(laneDir) ? laneDir : dirname(bundle), ['bundle', 'list-heads', bundle]) || '';
    const refs = headsText.split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length === 2 && p[1].startsWith('refs/salvage/'));
    const head = refs.find(([, r]) => r.endsWith('-head'));
    const wip = refs.find(([, r]) => r.endsWith('-wip'));
    const patch = join(dir, `lane-${lane}.uncommitted.patch`);
    const changed = new Set();
    if (existsSync(patch)) for (const m of readFileSync(patch, 'utf8').matchAll(/^diff --git a\/(\S+) b\//gm)) changed.add(m[1]);
    const untracked = join(dir, `lane-${lane}.untracked.txt`);
    if (existsSync(untracked)) for (const l of readFileSync(untracked, 'utf8').split('\n').map((x) => x.trim()).filter(Boolean)) changed.add(l);
    const lh = readLastHolder(lane) || {};
    const targets = deriveSalvageTargets({ purpose: lh.purpose, holder: lh.holder, session: lh.session });
    const ts = parseSalvageStamp(stamp);
    rows.push({
      ts: new Date(ts ?? now.getTime()).toISOString(), pool, lane, dir: laneDir, stamp, outDir: dir, bundle,
      patches: existsSync(patch) ? [patch] : [], reason: 'operator manual salvage (backfilled into the index)',
      lastHolder: { purpose: lh.purpose ?? null, holder: lh.holder ?? null, session: lh.session ?? null },
      branch: null, head: head ? head[0] : null, cards: targets.cards, prs: targets.prs,
      changedFiles: [...changed].sort(), refs: refs.map(([, r]) => r),
      snapshots: head || wip ? [{ worktree: null, headSha: head ? head[0] : null, wipSha: wip ? wip[0] : null, aheadCount: null, dirtyCount: null }] : [],
      landed: false, backfilled: true, recover: `git fetch ${bundle} 'refs/salvage/*:refs/salvage/*'`,
    });
  }
  if (rows.length) updateSalvageIndex(root, (entries) => [...entries, ...rows]);
  return rows;
}
