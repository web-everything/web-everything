/**
 * @file scripts/conveyor/scope-bloat.mjs — card x29vm8a. Do not review a diff that is mostly someone else's work.
 *
 * Live 2026-10-08, #4361: the PR's diff was +3277/-96 across 44 files when its own change was about 5. The branch
 * carried other lanes' work on a stale base, so every review re-read all of it (and raised findings about it). The
 * remedy is upstream of the review: before a review is dispatched, a PR whose diff includes files that are already on
 * `main`, or files far outside its card's `scope:`, is refreshed onto `main` through the existing mechanical path
 * (`ci-red-recovery-watch.mjs#refreshOntoMain`, the shared `rebaseDropManifest` plumbing) and, when that cannot fix it,
 * held with reason `scope-bloat` and routed to a fixer to rebase. It never reviews the bloated diff.
 *
 * Two signals, each a knob (env, read once per call):
 *   - ALREADY ON MAIN. A file in the PR's file list whose content is identical to `origin/main`'s — it is in the PR
 *     diff only because the branch's base is older than the commit that put it on `main`. At least
 *     `WE_REVIEW_SCOPE_BLOAT_ALREADY_ON_MAIN` of them (default 3; one coincidence is not a stale base).
 *   - FAR OUTSIDE THE CARD'S SCOPE. More than `WE_REVIEW_SCOPE_BLOAT_OUTSIDE_SCOPE` (default 10) files that match no
 *     entry of the card's `scope:`. Backlog cards, tests beside a scoped file and docs are not counted: they are the
 *     normal companions of a change. Only judged when the card declares a scope and the PR is over
 *     `WE_REVIEW_SCOPE_BLOAT_MIN_FILES` (default 12) files, so a small PR never reads a card. (The already-on-main read is gated
 *     only by the PR having at least `ALREADY_ON_MAIN` files, so a small stale PR is still caught.)
 *
 * PURE except the `enrich*` functions at the bottom, which are the io shell and fail OPEN: an unreadable diff or card
 * is "no claim", never a hold.
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countRebaseOntoMainComments } from './main-red-recovery.mjs';
import { repoKeyForSlug } from '../lib/constellation-repos.mjs';
import { coversFile } from '../readiness/scope-lease.mjs';

export const SCOPE_BLOAT_REASON = 'scope-bloat';
export const SCOPE_BLOAT_DEFAULTS = Object.freeze({ alreadyOnMain: 3, outsideScope: 10, minFiles: 12 });

const knob = (env, name, fallback) => {
  const raw = env?.[name];
  if (raw == null || raw === '') return fallback;
  // An operator's "turn it off" must not silently leave the signal on at its default.
  if (/^(off|false|no|disabled?)$/i.test(String(raw).trim())) return 0;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
};

/** The thresholds in force. `0` for a knob turns that signal off (`minFiles` gates the scope signal only). */
export function scopeBloatLimits(env = process.env) {
  return {
    alreadyOnMain: knob(env, 'WE_REVIEW_SCOPE_BLOAT_ALREADY_ON_MAIN', SCOPE_BLOAT_DEFAULTS.alreadyOnMain),
    outsideScope: knob(env, 'WE_REVIEW_SCOPE_BLOAT_OUTSIDE_SCOPE', SCOPE_BLOAT_DEFAULTS.outsideScope),
    minFiles: knob(env, 'WE_REVIEW_SCOPE_BLOAT_MIN_FILES', SCOPE_BLOAT_DEFAULTS.minFiles),
  };
}

const isCompanion = (path) => /^backlog\//.test(path) || /(^|\/)__tests__\//.test(path) || /\.test\.[cm]?[jt]s$/.test(path)
  || /\.md$/.test(path);

/** A card's `scope:` entry as a WE-qualified pattern: an unqualified entry is this repo's, and a `./` lead is dropped. */
const qualify = (raw) => {
  const entry = String(raw ?? '').trim();
  if (!entry) return '';
  const qualified = /^[a-z][a-z0-9-]*:/i.test(entry) ? entry : `we:${entry}`;
  return qualified.replace(/^([a-z][a-z0-9-]*:)(?:\.\/)+/i, '$1').replace(/^[a-z][a-z0-9-]*:/i, (p) => p.toLowerCase());
};

/**
 * Does the Web Everything file `path` fall under one `scope:` entry? Uses the same matcher the scope lease does
 * (`scope-lease.mjs#coversFile`), because cards write scope in four shapes: an exact file, `dir/`, a bare directory
 * with no trailing slash (`we:scripts/conveyor`), and a glob. A file entry matches only itself; a directory entry
 * matches everything beneath it, not a sibling that merely shares its name as a prefix. An entry for another repo
 * (`frontierui:...`) never matches a Web Everything path.
 */
export function inScope(path, scope) {
  const file = `we:${String(path ?? '')}`;
  return (Array.isArray(scope) ? scope : []).some((raw) => {
    const entry = qualify(raw);
    if (entry === '') return false;
    if (coversFile(entry, file)) return true;
    // `coversFile` reads a last segment with an extension as a FILE, so a dotted directory written without a trailing
    // slash (`we:.github`, `we:docs/v1.2`) would match only itself and every child would count as outside scope. Also
    // read a non-glob entry as a directory prefix: no real path sits beneath a file, so this cannot over-match.
    const body = entry.slice(entry.indexOf(':') + 1).replace(/\/$/, '');
    return body !== '' && !/[*?]/.test(body) && entry.slice(0, entry.indexOf(':')) === 'we' && file.slice(3).startsWith(`${body}/`);
  });
}

/** The far-outside-scope signal is on only when BOTH its knobs are positive: `0` on either is the documented off switch. */
const scopeSignalOn = (limits) => limits.outsideScope > 0 && limits.minFiles > 0;

/**
 * The verdict for one PR. PURE.
 * @param {{prFiles: Array<string|{path: string}>, netFiles?: (Iterable<string>|null), cardScope?: (string[]|null), env?: object}} o
 *   `netFiles` = the paths that differ between current `main` and the PR head (a two-dot diff). `null` = unknown.
 * @returns {null | {reason: 'scope-bloat', files: number, alreadyOnMain: string[], outsideScope: string[], why: string}}
 */
export function assessScopeBloat({ prFiles, netFiles = null, cardScope = null, env = process.env } = {}) {
  const limits = scopeBloatLimits(env);
  const files = (Array.isArray(prFiles) ? prFiles : []).map((f) => (typeof f === 'string' ? f : f?.path)).filter(Boolean);
  const net = netFiles ? new Set(netFiles) : null;
  const alreadyOnMain = net ? files.filter((p) => !net.has(p)) : [];
  const scope = Array.isArray(cardScope) && cardScope.length ? cardScope : null;
  const outsideScope = scope && scopeSignalOn(limits) && files.length >= limits.minFiles
    ? files.filter((p) => !isCompanion(p) && !inScope(p, scope) && (!net || net.has(p))) : [];
  const stale = limits.alreadyOnMain > 0 && alreadyOnMain.length >= limits.alreadyOnMain;
  const wide = limits.outsideScope > 0 && outsideScope.length > limits.outsideScope;
  if (!stale && !wide) return null;
  const parts = [];
  if (stale) parts.push(`${alreadyOnMain.length} of its ${files.length} files are already on main (a stale base)`);
  if (wide) parts.push(`${outsideScope.length} files sit outside its card's scope`);
  return { reason: SCOPE_BLOAT_REASON, files: files.length, alreadyOnMain, outsideScope, stale, wide,
    why: `the diff is mostly not this PR's own change: ${parts.join('; ')} — refresh onto main or rebase before a review reads it` };
}

/** The card id a PR names in its title, e.g. "WE #xykwe0h: build — ..." -> "xykwe0h". Null when none. */
export function cardIdFromTitle(title) {
  const m = /#([0-9a-z]{3,8})\b/i.exec(String(title ?? ''));
  return m ? m[1].toLowerCase() : null;
}

/** The `scope:` array out of a card's frontmatter text (inline `[..]` or a `- item` list). `[]` when none. PURE. */
export function parseCardScope(text) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(String(text ?? ''));
  if (!fm) return [];
  const inline = /^scope:\s*\[(.*)\]\s*$/m.exec(fm[1]);
  if (inline) return inline[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  const block = /^scope:\s*\n((?:[ \t]+-[^\n]*\n?)+)/m.exec(`${fm[1]}\n`);
  return block ? block[1].split('\n').map((l) => l.replace(/^\s*-\s*/, '').trim().replace(/^["']|["']$/g, '')).filter(Boolean) : [];
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const git = (args, root) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

/** The files that differ between `origin/<base>` and `head` (a two-dot diff), fetching the head ref once if missing. */
export function readNetFiles({ headRefName, headRefOid, base = 'main', root = ROOT, run = git } = {}) {
  // A head ref is author-supplied; a leading `-` would be read by git as an option, so refuse it before any git call.
  if (typeof headRefName !== 'string' || headRefName.startsWith('-')) throw new Error('unsafe head ref name');
  try { run(['cat-file', '-e', `${headRefOid}^{commit}`], root); }
  catch { run(['fetch', '-q', 'origin', headRefName], root); }
  return run(['diff', '--name-only', `origin/${base}`, headRefOid], root).split('\n').filter(Boolean);
}

/** The card's `scope:` as it is on `origin/<base>`, or `null` (no card / no scope / unreadable). */
export function readCardScope({ title, base = 'main', root = ROOT, run = git } = {}) {
  const id = cardIdFromTitle(title);
  if (!id) return null;
  try {
    const name = run(['ls-tree', '--name-only', `origin/${base}`, 'backlog/'], root).split('\n').find((p) => p.startsWith(`backlog/${id}-`));
    if (!name) return null;
    const scope = parseCardScope(run(['show', `origin/${base}:${name}`], root));
    return scope.length ? scope : null;
  } catch { return null; }
}

const memo = new Map();
const unreadable = new Set();
const refreshes = new Map();
const refreshKey = (pr, head) => `${pr}:${head}`;

/** Remember that the mechanical refresh was tried on this exact head (one attempt per head), and what it answered. */
export function recordScopeBloatRefresh(pr, head, result) {
  refreshes.set(refreshKey(pr, head), { attempted: true, ok: result?.ok === true, action: result?.action ?? null, error: result?.error ?? null });
  if (refreshes.size > 500) refreshes.delete(refreshes.keys().next().value);
}

/** The recorded refresh attempt for this head, or `null` (none yet). */
export const scopeBloatRefreshFor = (pr, head) => refreshes.get(refreshKey(pr, head)) ?? null;

export const MARKER_RETRIES_PER_HEAD = 3;
const markerFailures = new Map();

/**
 * The durable per-head marker could not be posted, so the fix daemon (another process, reading only the thread) cannot
 * see the attempt and would wait on a refresh that never shows. Forget the in-process record so the next tick tries the
 * refresh (idempotent: an up-to-date branch answers `current`) and the marker again, at most {@link MARKER_RETRIES_PER_HEAD}
 * times per head; after that the record stays, so a marker that can never be posted does not refresh every tick forever.
 * @returns {boolean} true when the record was forgotten (a retry is owed)
 */
export function noteScopeBloatMarkerFailure(pr, head) {
  const key = refreshKey(pr, head);
  const n = (markerFailures.get(key) ?? 0) + 1;
  markerFailures.set(key, n);
  if (markerFailures.size > 500) markerFailures.delete(markerFailures.keys().next().value);
  if (n > MARKER_RETRIES_PER_HEAD) return false;
  refreshes.delete(key);
  return true;
}

/** The base branch tip the assessment was made against, or `'unknown'` (unreadable: still assessed, keyed apart from any real sha). */
export function readBaseSha({ base = 'main', root = ROOT, run = git } = {}) {
  return run(['rev-parse', '--verify', `origin/${base}^{commit}`], root).trim() || 'unknown';
}

/**
 * Attach `pr.scopeBloat` to each open, non-draft PR whose diff is bloated. FAILS OPEN per PR: any read error leaves the
 * PR unannotated. Memoized per (PR, head, base tip), so a PR that stays bloated on an unmoved `main` costs one git read,
 * not one per tick, while a `main` that advances (another lane's commits landing turn files of this diff into
 * already-on-main files) reassesses the same head. This reads the local `origin/<base>`; it does not fetch it.
 * Only the Web Everything repo is read (the git root is this clone); other repos pass through.
 */
export function enrichPrsWithScopeBloat(prs, { repo = null, defaultBranch = 'main', env = process.env, root = ROOT,
  readNet = readNetFiles, readScope = readCardScope, readBaseSha: readBase = readBaseSha } = {}) {
  if (!Array.isArray(prs) || (repo && repoKeyForSlug(repo) !== 'we')) return prs;
  const limits = scopeBloatLimits(env);
  let baseSha = null; // read once per call, lazily: a pass over PRs that all fail the cheap checks never shells out
  const baseTip = () => {
    if (baseSha == null) { try { baseSha = readBase({ base: defaultBranch, root }) || 'unknown'; } catch { baseSha = 'unknown'; } }
    return baseSha;
  };
  return prs.map((pr) => {
    try {
      if (pr?.isDraft || !pr?.headRefOid || !Array.isArray(pr.files)) return pr;
      // A head that cannot be read stays unreadable whatever `main` does: remember that per head, not per main tip, so it
      // costs one failed read (cat-file, fetch, diff; 30 s each) rather than one per main advance.
      const headKey = `${pr.number}:${pr.headRefOid}`;
      if (unreadable.has(headKey)) return pr;
      const key = `${headKey}:${baseTip()}`;
      if (!memo.has(key)) {
        const lazy = scopeSignalOn(limits) && pr.files.length >= limits.minFiles;
        // Stale-base needs the net diff for any PR big enough to hold that many files; the card scope only for big ones.
        const needNet = lazy || (limits.alreadyOnMain > 0 && pr.files.length >= limits.alreadyOnMain);
        // An unreadable diff is remembered as "no claim" too, so a PR whose head cannot be fetched costs one failed read, not one per tick.
        let net = null;
        try { net = needNet ? readNet({ headRefName: pr.headRefName, headRefOid: pr.headRefOid, base: defaultBranch, root }) : null; }
        catch { unreadable.add(headKey); if (unreadable.size > 500) unreadable.delete(unreadable.values().next().value); return pr; }
        const scope = lazy ? readScope({ title: pr.title ?? '', base: defaultBranch, root }) : null;
        memo.set(key, assessScopeBloat({ prFiles: pr.files, netFiles: net, cardScope: scope, env }));
        if (memo.size > 500) memo.delete(memo.keys().next().value);
      }
      const bloat = memo.get(key);
      // The attempt is remembered in this process AND on the thread (the `conveyor rebase-onto-main` marker, per head),
      // because the fix daemon is another process and must see that the refresh was tried.
      const refresh = bloat ? (scopeBloatRefreshFor(pr.number, pr.headRefOid)
        ?? (countRebaseOntoMainComments(pr.comments, pr.headRefOid) > 0 ? { attempted: true, ok: null, action: 'marker', error: null } : null)) : null;
      return bloat ? { ...pr, scopeBloat: refresh ? { ...bloat, refresh } : bloat } : pr;
    } catch { return pr; }
  });
}
