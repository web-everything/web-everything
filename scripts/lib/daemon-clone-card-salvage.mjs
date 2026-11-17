/**
 * daemon-clone-card-salvage.mjs — clear a daemon clone's untracked backlog cards once they are safe to move.
 *
 * Root cause this answers: the fix and review daemons run `scripts/backlog.mjs scaffold` / `file-item` from
 * their OWN clone (backlog.mjs resolves ROOT from its own file location, scripts/backlog.mjs:86/92), so a card
 * they file is written into that clone's `backlog/` as an untracked file and never lands. Untracked files also
 * make `git status --porcelain` dirty, so selfSyncCheckout (daemon-self-sync.mjs) skips every catch-up merge.
 *
 * Decision (pure): an untracked `backlog/<id>-*.md` is MOVED only when its id is on origin/main, or the id is
 * listed DUP/STALE by a triage. Anything else is KEPT. Nothing is ever deleted: a move is a rename into a salvage
 * dir (a name collision there gets a numeric suffix, never an overwrite).
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';

const CARD_RE = /^backlog\/([^/]+)\.md$/;

/** The card id: the file-name prefix before the first '-' (a number, or a bornAs `x…` token). */
export function cardIdOf(path) {
  const m = CARD_RE.exec(path);
  if (!m) return null;
  const stem = m[1];
  const i = stem.indexOf('-');
  return i > 0 ? stem.slice(0, i) : stem;
}

/**
 * @param {{untracked:string[], mainIds:Set<string>|null, triaged?:{dup?:Iterable<string>, stale?:Iterable<string>}}} o
 * @returns {{move:{path:string,id:string,reason:string}[], keep:{path:string,id:string,reason:string}[]}}
 */
export function decideCardSalvage({ untracked, mainIds, triaged = {} }) {
  const dup = new Set(triaged.dup ?? []);
  const stale = new Set(triaged.stale ?? []);
  const move = [];
  const keep = [];
  for (const path of untracked) {
    const id = cardIdOf(path);
    if (!id) continue;
    if (mainIds === null || mainIds === undefined) keep.push({ path, id, reason: 'main-unreadable' });
    else if (mainIds.has(id)) move.push({ path, id, reason: 'on-main' });
    else if (dup.has(id)) move.push({ path, id, reason: 'triaged-dup' });
    else if (stale.has(id)) move.push({ path, id, reason: 'triaged-stale' });
    else keep.push({ path, id, reason: 'unknown' });
  }
  return { move, keep };
}

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
const git = (root, args) => execFileSync('git', args, { cwd: root, env: cleanEnv(), encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 });

function untrackedCards(root) {
  const out = git(root, ['status', '--porcelain', '--untracked-files=all', '--', 'backlog/']);
  return out.split('\n').filter((l) => l.startsWith('?? ')).map((l) => l.slice(3).trim());
}

/** id → repo path of the card on origin/<base>; null when main is unreadable (fail closed: keep everything). */
function mainCardPaths(root, base) {
  try {
    const out = git(root, ['ls-tree', '--name-only', `origin/${base}`, 'backlog/']);
    const map = new Map();
    for (const p of out.split('\n').map((s) => s.trim())) { const id = cardIdOf(p); if (id) map.set(id, p); }
    return map;
  } catch { return null; }
}

/** True when `origin/<base>:<path>` really exists as an object (guard: same-id file proven on main). */
function existsOnMain(root, base, path) {
  try { git(root, ['cat-file', '-e', `origin/${base}:${path}`]); return true; } catch { return false; }
}

/** Cheap pre-check (no lock): does this clone hold any untracked backlog card? Unreadable ⇒ false. */
export function hasUntrackedCards(root) {
  try { return untrackedCards(root).some((p) => cardIdOf(p)); } catch { return false; }
}

/** Load the recorded DUP/STALE triage `{dup:[ids], stale:[ids]}`; missing or unreadable ⇒ empty (nothing triaged). */
export function loadCardTriage(file) {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    return { dup: Array.isArray(v?.dup) ? v.dup.map(String) : [], stale: Array.isArray(v?.stale) ? v.stale.map(String) : [] };
  } catch { return { dup: [], stale: [] }; }
}

/**
 * Race-free move: a single rename() into the salvage dir under a name that is unique per move (random suffix), so
 * no existing salvaged file can ever be overwritten and no exclusive-create/unlink pair exists. rename() moves
 * whatever is at the source at that instant, so a concurrent replacement is salvaged too, never lost.
 */
function moveUnique(src, dir, name) {
  const target = join(dir, `${name}.${randomUUID()}`);
  renameSync(src, target);
  return target;
}

/**
 * IO: move this clone's salvage-eligible untracked cards into `salvageDir`. Never throws on a per-file failure.
 * @returns {{moved:object[], kept:object[], failed:object[]}}
 */
export function salvageUntrackedCards({ root, salvageDir, triaged = {}, base = 'main' }) {
  let untracked;
  try { untracked = untrackedCards(root); } catch { return { moved: [], kept: [], failed: [{ reason: 'status-failed' }] }; }
  const mainPaths = mainCardPaths(root, base);
  const decided = decideCardSalvage({ untracked, mainIds: mainPaths ? new Set(mainPaths.keys()) : null, triaged });
  const keep = [...decided.keep];
  const move = [];
  for (const m of decided.move) {
    if (m.reason === 'on-main' && !existsOnMain(root, base, mainPaths.get(m.id))) keep.push({ ...m, reason: 'main-unverified' });
    else move.push(m);
  }
  const moved = [];
  const failed = [];
  if (move.length) mkdirSync(salvageDir, { recursive: true });
  for (const m of move) {
    try {
      const target = moveUnique(join(root, m.path), salvageDir, basename(m.path));
      moved.push({ ...m, to: target });
    } catch (e) { failed.push({ ...m, error: String(e?.code ?? e) }); }
  }
  return { moved, kept: keep, failed };
}
