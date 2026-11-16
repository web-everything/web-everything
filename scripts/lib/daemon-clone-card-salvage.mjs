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
import { existsSync, mkdirSync, renameSync } from 'node:fs';
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

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 });

function untrackedCards(root) {
  const out = git(root, ['status', '--porcelain', '--untracked-files=all', '--', 'backlog/']);
  return out.split('\n').filter((l) => l.startsWith('?? ')).map((l) => l.slice(3).trim());
}

function mainCardIds(root, base) {
  try {
    const out = git(root, ['ls-tree', '--name-only', `origin/${base}`, 'backlog/']);
    return new Set(out.split('\n').map((p) => cardIdOf(p.trim())).filter(Boolean));
  } catch { return null; }
}

function freeName(dir, name) {
  if (!existsSync(join(dir, name))) return name;
  for (let n = 1; ; n++) { const c = `${name}.${n}`; if (!existsSync(join(dir, c))) return c; }
}

/**
 * IO: move this clone's salvage-eligible untracked cards into `salvageDir`. Never throws on a per-file failure.
 * @returns {{moved:object[], kept:object[], failed:object[]}}
 */
export function salvageUntrackedCards({ root, salvageDir, triaged = {}, base = 'main' }) {
  let untracked;
  try { untracked = untrackedCards(root); } catch { return { moved: [], kept: [], failed: [{ reason: 'status-failed' }] }; }
  const { move, keep } = decideCardSalvage({ untracked, mainIds: mainCardIds(root, base), triaged });
  const moved = [];
  const failed = [];
  if (move.length) mkdirSync(salvageDir, { recursive: true });
  for (const m of move) {
    try {
      const target = join(salvageDir, freeName(salvageDir, basename(m.path)));
      renameSync(join(root, m.path), target);
      moved.push({ ...m, to: target });
    } catch (e) { failed.push({ ...m, error: String(e?.code ?? e) }); }
  }
  return { moved, kept: keep, failed };
}
