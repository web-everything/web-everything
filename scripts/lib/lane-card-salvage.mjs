/**
 * @file scripts/lib/lane-card-salvage.mjs
 * @description Save, then clean, backlog card files a filer left behind in a pool lane (R310).
 *
 * WHY. 2026-11-01 03:25 ET: 75 of 90 web-everything pool lanes were DIRTY with nothing but leftover card files —
 * an untracked `backlog/x*-prevention-*.md`, a staged `backlog/raised-by/<id>/<n>-<hash>.md`. The prevention-card
 * filer (`we:scripts/operations/land-prevention-card.mjs`) released its lane on every exit path, but never cleaned
 * it: after a batched / held filing, and after any failed step, the card stayed in the lane's tree. A dirty lane is
 * never acquirable, so the pool ran out and the daemons stalled (#6044/#6046).
 *
 * WHAT. {@link planLaneCardDirt} (PURE) reads a lane's `git status --porcelain --untracked-files=all` and says
 * whether its ONLY dirt is new card files (untracked, or staged as added) plus known-safe scratch litter
 * (`./lane-litter.mjs`). {@link salvageLaneCards} acts only on such a lane: it copies every card file, byte for byte,
 * into `<salvageRoot>/<pool>/<stamp>-cards-lane-N/<path>`, re-reads each copy to prove it, appends one row to the
 * shared salvage index (`./lane-salvage.mjs`, the same index `reclaim --salvage` writes), and only then unstages
 * and takes the lane's copies out (moved under the salvage root, never unlinked). Any failure before that leaves
 * the lane exactly as it was.
 *
 * Callers: the filer's own `finally` (before it releases) and `lane-pool.mjs release` (the backstop for a filer
 * that was killed before its `finally` ran). A lane with any OTHER dirt is never touched here (`mixed`).
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync,
  rmdirSync, rmSync, mkdtempSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { laneGitHardeningEnv } from './lane-git-hardening.mjs';
import { readGit } from './proc-read.mjs';
import { isAllowlistedLitterPath } from './lane-litter.mjs';
import { appendSalvageIndex, buildSalvageRecord, resolveSalvageRoot, salvageStamp } from './lane-salvage.mjs';

/** A new card file: anything under `backlog/` ending `.md`, never a traversal. PURE. */
export function isCardFilePath(path) {
  const p = String(path || '');
  return /^backlog\/(?:[^/]+\/)*[^/]+\.md$/.test(p) && !p.split('/').includes('..');
}

// `AM` (staged, then edited) is NOT a card here: its index bytes differ from the file, so it is left for a human.
// `AD` is an incomplete cleanup (or a manually deleted staged addition), never an absent/clean card.
const CARD_STATUSES = new Set(['??', 'A ']);

/** Allowlisted litter, or a file inside an allowlisted litter directory (`-uall` lists `tmp/x`, not `tmp/`). */
const isLitter = (path) => isAllowlistedLitterPath(path)
  || path.split('/').slice(0, -1).some((_, i, parts) => isAllowlistedLitterPath(`${parts.slice(0, i + 1).join('/')}/`));

/**
 * PURE. Classify a lane's porcelain (`--untracked-files=all`). `cardOnly` is true when there is at least one card
 * file and every other entry is known-safe untracked litter.
 * @param {string|null} porcelain
 * @returns {{cards: {status: string, path: string}[], litter: string[], other: string[], cardOnly: boolean}}
 */
export function planLaneCardDirt(porcelain) {
  const cards = []; const litter = []; const other = [];
  for (const line of String(porcelain || '').split('\n').filter(Boolean)) {
    const status = line.slice(0, 2);
    const path = line.slice(3);
    // Quoted AD paths only need classification: they are never passed to filesystem or index mutations.
    if (status === 'AD' && isCardFilePath(path.startsWith('"') ? path.slice(1, -1) : path)) cards.push({ status, path });
    else if (CARD_STATUSES.has(status) && !path.startsWith('"') && isCardFilePath(path)) cards.push({ status, path });
    else if (status === '??' && isLitter(path)) litter.push(path);
    else other.push(path);
  }
  return { cards, litter, other, cardOnly: cards.length > 0 && other.length === 0 };
}

const git = (dir, args) => readGit(args, {
  cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
  env: laneGitHardeningEnv({ ...process.env, GIT_OPTIONAL_LOCKS: '0' }),
});

const cardIdOfPath = (path) => /^backlog\/raised-by\/([^/]+)\//.exec(path)?.[1] ?? /^backlog\/([^/-]+)-/.exec(path)?.[1] ?? null;

/** Remove now-empty directories from `rel`'s parent up to (not including) `backlog/`. */
function pruneEmptyParents(dir, rel) {
  for (let parent = dirname(rel); parent.startsWith('backlog/'); parent = dirname(parent)) {
    const abs = join(dir, parent);
    try { if (readdirSync(abs).length) return; rmdirSync(abs); } catch { return; }
  }
}

/**
 * Save the lane's card files durably, prove the save, then remove them from the lane.
 * Requires an explicit ownership predicate (missing predicates throw before IO). Otherwise returns `unknown`
 * (initial status unreadable; untouched, no cards identified), `none` (no card dirt), `mixed` (other dirt too;
 * untouched), `failed` (ownership unproven, known cards could not be saved or cleaning did not
 * complete — the saved copies stay) or `salvaged`. An unreadable re-check after identifying cards is `failed`.
 * @param {{dir: string, lane: (number|string), pool?: string, reason?: string, salvageRoot?: string, now?: Date,
 *   gitRun?: (dir: string, args: string[]) => string, isLeaseCurrent: () => boolean}} o
 */
export function salvageLaneCards({
  dir, lane, pool = 'web-everything', reason = 'card files left in a lane at release', salvageRoot = resolveSalvageRoot(),
  now = new Date(), gitRun = git, isLeaseCurrent,
}) {
  if (typeof isLeaseCurrent !== 'function') throw new TypeError('salvageLaneCards requires isLeaseCurrent');
  let plan; let porcelain;
  try { if (!isLeaseCurrent()) return { status: 'failed', reason: 'lease changed before card salvage; lane untouched', removed: [] }; }
  catch { return { status: 'failed', reason: 'lease ownership unreadable; lane untouched', removed: [] }; }
  try { porcelain = gitRun(dir, ['status', '--porcelain', '--untracked-files=all']); plan = planLaneCardDirt(porcelain); }
  catch (e) { return { status: 'unknown', reason: `status read failed: ${String(e?.message || e).split('\n')[0]}`, removed: [] }; }
  const pending = plan.cards.filter(({ status }) => status === 'AD');
  // A previous retirement may have succeeded while unstaging failed or the process died. Keep the lease even
  // with mixed dirt; neither missing working files nor a later retry prove the index cleanup completed.
  if (pending.length) return { status: 'failed', reason: `staged card deletion needs recovery: ${pending.map(({ path }) => path).join(', ')}; inspect the saved copies and index, resolve the staged deletion, then retry release`, removed: [] };
  if (!plan.cards.length) return { status: 'none', removed: [] };
  if (!plan.cardOnly) return { status: 'mixed', other: plan.other, removed: [] };
  const stamp = `${salvageStamp(now)}-cards-lane-${lane}`;
  const outDir = join(salvageRoot, pool, stamp);
  const copies = [];
  const checkLease = () => { if (!isLeaseCurrent()) throw new Error('lease changed during card salvage; not cleaning'); };
  try {
    for (const { path } of plan.cards) {
      checkLease();
      const src = join(dir, path);
      if (!lstatSync(src).isFile()) throw new Error(`${path} is not a regular file`);
      const dest = join(outDir, path);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest, fsConstants.COPYFILE_EXCL);
      if (!readFileSync(dest).equals(readFileSync(src))) throw new Error(`copy of ${path} does not match`);
      copies.push({ rel: path, dest });
    }
    let branch = null;
    try { branch = gitRun(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(); } catch { branch = null; }
    checkLease();
    appendSalvageIndex(salvageRoot, buildSalvageRecord({
      now, pool, lane: Number(lane), dir, stamp, outDir, bundle: null, reason, branch,
      meta: { cards: [...new Set(plan.cards.map(({ path }) => cardIdOfPath(path)).filter(Boolean))] },
      refs: [], localRefs: [], snapshots: [], changedFiles: plan.cards.map(({ path }) => path), litter: copies,
    }));
  } catch (e) {
    return { status: 'failed', reason: `salvage copy failed, lane untouched: ${String(e?.message || e).split('\n')[0]}`, outDir, removed: [] };
  }
  const removed = [];
  const expected = new Map();
  try {
    // Re-check right before the first delete: the lane must be exactly as classified. Anything that changed since
    // (a new edit, a new holder's work) stops the clean; the copies stay.
    const again = gitRun(dir, ['status', '--porcelain', '--untracked-files=all']);
    if (again !== porcelain) throw new Error('lane changed after the save; not cleaning');
    checkLease();
    for (const { rel, dest } of copies) {
      expected.set(rel, readFileSync(dest));
      if (!retireIfUnchanged(dir, rel, expected.get(rel), join(outDir, 'retired'), isLeaseCurrent)) throw new Error(`${rel} changed after the save; left in the lane`);
      removed.push(rel);
    }
    checkLease();
    unstage(dir, plan.cards, removed, gitRun, isLeaseCurrent, expected, outDir);
    const left = planLaneCardDirt(gitRun(dir, ['status', '--porcelain', '--untracked-files=all'])).cards;
    if (left.length) throw new Error(`still present: ${left.map(({ path }) => path).join(', ')}`);
  } catch (e) {
    try { if (isLeaseCurrent()) unstage(dir, plan.cards, removed, gitRun, isLeaseCurrent, expected, outDir); } catch { /* changed index entries stay staged; saved bytes stay */ }
    return { status: 'failed', reason: `clean after salvage incomplete (copies kept in ${outDir}): ${String(e?.message || e).split('\n')[0]}`, outDir, removed };
  }
  return { status: 'salvaged', outDir, removed };
}

/**
 * Take `rel` out of the lane only if its bytes equal `expected`; otherwise leave it exactly where it is. The file is
 * never unlinked: it is RENAMED into `trashDir` under the salvage root (outside the lane, so a later `trim`/`remove` of
 * the lane cannot reach it; never expired by `salvage-index.mjs`), so even a write that races the compare through an
 * already-open descriptor lands in a kept inode. A rename across filesystems fails (EXDEV) and moves nothing.
 */
function retireIfUnchanged(dir, rel, expected, trashDir, isLeaseCurrent) {
  const src = join(dir, rel);
  if (!readFileSync(src).equals(expected)) return false;
  mkdirSync(trashDir, { recursive: true });
  if (!isLeaseCurrent()) throw new Error('lease changed during card retirement; not cleaning');
  renameSync(src, join(trashDir, `${Date.now()}-${randomUUID()}-${basename(rel)}`));
  pruneEmptyParents(dir, rel);
  return true;
}

/**
 * Delete only index blobs equal to the saved bytes. A binary deletion patch carries the full old object ID;
 * `git apply --cached` validates it while holding Git's index lock, then writes the index atomically. Unlike
 * `rm --cached` after retirement, it cannot discard a concurrently staged version just because the file is absent.
 * Text patches are insufficient here: whitespace settings can relax their comparisons. Keep this binary even
 * for text cards, and pin the bytes compared BEFORE retirement (an open descriptor can still change the inode).
 */
function unstage(dir, cards, removed, gitRun, isLeaseCurrent, expected, scratchRoot) {
  const done = new Set(removed);
  const staged = cards.filter(({ status, path }) => status !== '??' && done.has(path) && !existsSync(join(dir, path)));
  if (staged.length) {
    if (!isLeaseCurrent()) throw new Error('lease changed before unstaging cards; index untouched');
    const format = gitRun(dir, ['rev-parse', '--show-object-format']).trim();
    if (!['sha1', 'sha256'].includes(format)) throw new Error('unknown Git object format; index untouched');
    const patch = staged.map(({ path }) => {
      const bytes = expected.get(path);
      if (!Buffer.isBuffer(bytes)) throw new Error(`missing saved bytes for ${path}; index untouched`);
      const oid = createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      // Git's quoted path syntax handles spaces, quotes and backslashes without pathspec interpretation.
      return `diff --git ${JSON.stringify(`a/${path}`)} ${JSON.stringify(`b/${path}`)}\n`
        + `deleted file mode 100644\nindex ${oid}..${'0'.repeat(oid.length)}\n`
        + 'GIT binary patch\nliteral 0\nHcmV?d00001\n\n';
    }).join('');
    mkdirSync(scratchRoot, { recursive: true });
    const scratch = mkdtempSync(join(scratchRoot, 'unstage-'));
    try {
      const patchFile = join(scratch, 'cards.patch');
      writeFileSync(patchFile, patch, { flag: 'wx' });
      if (!isLeaseCurrent()) throw new Error('lease changed before unstaging cards; index untouched');
      gitRun(dir, ['apply', '--cached', '--binary', '--', patchFile]);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }
}

/**
 * Remove ONE filing's own card files from a lane after the cards are durable elsewhere (pushed in a PR, admitted
 * to a batch, or spooled for the next batch window). `expected` maps each path to the exact text the filer handed
 * on; a file whose bytes differ now is left for the salvage pass. Requires an explicit ownership predicate
 * (missing predicates throw before IO). Returns removed paths only after unstaging succeeds; an unstaging
 * failure throws so the caller reports incomplete cleanup. The AD entries also block the release backstop.
 */
export function removeFiledCards({ dir, expected, pool = 'web-everything', salvageRoot = resolveSalvageRoot(), gitRun = git, isLeaseCurrent }) {
  if (typeof isLeaseCurrent !== 'function') throw new TypeError('removeFiledCards requires isLeaseCurrent');
  const wanted = new Map([...(expected ?? new Map())].filter(([path, text]) => isCardFilePath(path) && typeof text === 'string'));
  if (!wanted.size) return [];
  let plan;
  try {
    if (!isLeaseCurrent()) return [];
    plan = planLaneCardDirt(gitRun(dir, ['status', '--porcelain', '--untracked-files=all']));
  } catch { return []; }
  const mine = plan.cards.filter(({ path }) => wanted.has(path));
  const removed = [];
  try {
    for (const { path } of mine) if (retireIfUnchanged(dir, path, Buffer.from(wanted.get(path), 'utf8'), join(salvageRoot, pool, 'retired-cards'), isLeaseCurrent)) removed.push(path);
  } catch { /* the salvage pass that follows saves whatever is left */ }
  unstage(dir, mine, removed, gitRun, isLeaseCurrent,
    new Map([...wanted].map(([path, text]) => [path, Buffer.from(text, 'utf8')])), join(salvageRoot, pool, 'retired-cards'));
  return removed;
}
