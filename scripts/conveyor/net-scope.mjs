/**
 * @file scripts/conveyor/net-scope.mjs — card xd1tvd0. A PR's scope is what its head changes against current `main`.
 *
 * Live 2026-10-09 ~04:00Z: seven PRs (#4538 #4536 #4525 #4512 #4479 #4453 #4439) sat 80+ minutes in a deadlock.
 *   - The review daemon refused each review as `scope-bloat` ("98 of its 100 files are already on main"): it judged
 *     GitHub's PR file list, which still diffs against the PR's OLD base after the drain merged `main` into the branch,
 *     and stops at 100 files.
 *   - The fix daemon refused the owed rebase as `scope-overlap` ("we:backlog/4432-… overlaps in-flight fix PR #4527"):
 *     it fenced each PR with the same inflated lists, so every PR overlapped every other one.
 *   Against their merge-base with current `main` the seven PRs change 5 to 17 files each, none of them already on main.
 *
 * Three rules, each a declared setting (`net-scope-settings.json`, env beats file; missing/malformed/`off` = the
 * behaviour before this card):
 *   - `scopeBloat`   — scope-bloat judges the git net diff (head vs its merge-base with `origin/main`), not GitHub's list.
 *   - `fixOverlap`   — the fix daemon's scope-overlap fences (planned fixes AND the in-flight claims they wait on) are the
 *                      git net diff, not GitHub's list.
 *   - `rebaseExempt` — a stale-base scope-bloat fix is a rebase: it edits none of the PR's files, so scope-overlap never
 *                      blocks it (and it never blocks anyone). At most ONE exempt dispatch per PR head; a second one on
 *                      the same head waits like any other fix. The review round cap still bounds the rebases.
 *
 * The git read is #4525's `readNetFileSets` (free-scope-io.mjs), with ONE change: it never fetches `main`. The daemons
 * read the local `origin/main` and their self-sync owns moving it; a stale local main only WIDENS a net set, never narrows it.
 * PURE except the `read*`/`apply*` io shell at the bottom, which FAILS OPEN to GitHub's list (today's behaviour).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitExec, readNetFileSets } from '../operations/free-scope-io.mjs';

export const NET_SCOPE_ENV = Object.freeze({
  scopeBloat: 'WE_NET_SCOPE_SCOPE_BLOAT',
  fixOverlap: 'WE_NET_SCOPE_FIX_OVERLAP',
  rebaseExempt: 'WE_NET_SCOPE_REBASE_EXEMPT',
});
/** Off for every rule: exactly the behaviour before card xd1tvd0. */
export const NET_SCOPE_OFF = Object.freeze({ scopeBloat: false, fixOverlap: false, rebaseExempt: false });

export const netScopeSettingsPath = () => join(dirname(fileURLToPath(import.meta.url)), 'net-scope-settings.json');

const parseSwitch = (raw) => {
  if (typeof raw === 'boolean') return raw;
  const s = String(raw ?? '').trim().toLowerCase();
  if (/^(on|true|1|yes)$/.test(s)) return true;
  if (/^(off|false|0|no)$/.test(s)) return false;
  return null;
};

/** The three switches in force. Env beats the file; anything missing or malformed is `off` (today). */
export function resolveNetScopeSettings(env = process.env, { path = netScopeSettingsPath(), read = readFileSync } = {}) {
  let file = {};
  try { file = JSON.parse(read(path, 'utf8'))?.netScope ?? {}; } catch { file = {}; }
  const out = {};
  for (const key of Object.keys(NET_SCOPE_OFF)) out[key] = parseSwitch(env?.[NET_SCOPE_ENV[key]]) ?? parseSwitch(file[key]) ?? false;
  return out;
}

/**
 * The file list a PR is judged by. PURE. `net` is one `readNetFileSets` answer (`{ok, files}` or `{ok:false}`) or absent.
 * @returns {{source: 'git'|'github-list', files: string[]}}
 */
export function scopeFilesFor({ net, listed = [], on = true } = {}) {
  if (on && net?.ok && Array.isArray(net.files)) return { source: 'git', files: net.files };
  return { source: 'github-list', files: (Array.isArray(listed) ? listed : []).map((f) => (typeof f === 'string' ? f : f?.path)).filter(Boolean) };
}

/** A fix whose whole ask is a rebase onto main: stale-base scope-bloat and nothing else (a wide diff is not fixed by a rebase). PURE. */
export const isRebaseOnlyFix = (entry) => entry?.scopeBloat?.stale === true && entry.scopeBloat.wide !== true;

/**
 * Is this planned fix exempt from scope-overlap? PURE: `used` (a Set of `pr:head` keys the caller owns) is only read.
 * One exempt dispatch per PR head: the caller records a head with {@link markRebaseExemptUsed} once the fix is
 * actually dispatched (a fix deferred by the fixer cap or a missing lane keeps its exemption for the next pass).
 * @returns {{exempt: boolean, why: string}}
 */
export function rebaseOverlapExemption(entry, { on = false, used = new Set() } = {}) {
  if (!on) return { exempt: false, why: 'rebaseExempt is off' };
  if (!isRebaseOnlyFix(entry)) return { exempt: false, why: 'not a stale-base rebase' };
  if (!entry.headRefOid) return { exempt: false, why: 'no head commit to cap the exemption on' };
  if (used.has(rebaseHeadKey(entry))) return { exempt: false, why: 'this head already had its one exempt rebase' };
  return { exempt: true, why: 'a stale-base rebase edits none of the PR\'s files, so scope-overlap does not apply' };
}
export const rebaseHeadKey = (entry) => `${entry?.pr}:${entry?.headRefOid ?? ''}`;
/** Record that this head's one exempt rebase was dispatched. Bounded memory. */
export function markRebaseExemptUsed(entry, used) {
  used.add(rebaseHeadKey(entry));
  if (used.size > 500) used.delete(used.values().next().value);
}

/**
 * Rewrite a reconcile result's fences to the git net sets. PURE. `nets` = Map(prNumber → readNetFileSets answer).
 * `dispatch[].files` and `openPrFiles[].files` are replaced only where git answered; elsewhere they stay GitHub's list.
 * A net set of 100+ files becomes `null`, matching reconcile-core's "at the cap, read the full diff" contract.
 */
export function withNetFences(reconciled, nets) {
  if (!reconciled || !(nets instanceof Map) || !nets.size) return reconciled;
  const fence = (pr, files) => {
    const net = nets.get(Number(pr));
    if (!net?.ok) return files;
    return net.files.length < 100 ? net.files : null;
  };
  const rewritten = [];
  const dispatch = Array.isArray(reconciled.dispatch) ? reconciled.dispatch.map((entry) => {
    if (!entry || !nets.get(Number(entry.prNumber))?.ok) return entry;
    rewritten.push(Number(entry.prNumber));
    return { ...entry, files: fence(entry.prNumber, entry.files), filesSource: 'git' };
  }) : reconciled.dispatch;
  const openPrFiles = Array.isArray(reconciled.openPrFiles)
    ? reconciled.openPrFiles.map((row) => (nets.get(Number(row?.pr))?.ok ? { ...row, files: fence(row.pr, row.files), filesSource: 'git' } : row))
    : reconciled.openPrFiles;
  return { ...reconciled, dispatch, openPrFiles, netScope: { rewritten } };
}

// ── io shell ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** `git` for `readNetFileSets`, minus the `main` refspec on fetch: the daemon's self-sync owns `origin/main`. */
export function noBaseFetchGit(git = gitExec()) {
  return (dir, args) => {
    if (args[0] !== 'fetch') return git(dir, args);
    const kept = args.filter((a) => !String(a).startsWith('+refs/heads/'));
    if (!kept.some((a) => String(a).startsWith('refs/pull/'))) return '';
    return git(dir, kept);
  };
}

const memo = new Map();
/**
 * Net file sets for `rows` (`{number, headRefOid}`), memoized per (PR, head, local main tip). FAILS OPEN: any error is
 * `{ok:false}` for that PR, and the caller keeps GitHub's list.
 */
export function readNetSets(rows, { dir, git = noBaseFetchGit(), base = 'main', remote = 'origin' } = {}) {
  const out = new Map();
  let tip = 'unknown';
  try { tip = String(git(dir, ['rev-parse', '--verify', `${remote}/${base}^{commit}`])).trim() || 'unknown'; } catch { /* keyed apart */ }
  const todo = [];
  for (const row of rows) {
    const key = `${row.number}:${row.headRefOid}:${tip}`;
    if (memo.has(key)) out.set(row.number, memo.get(key)); else todo.push(row);
  }
  if (todo.length) {
    let fresh;
    try { fresh = readNetFileSets({ dir, rows: todo, git, remote, base }); } catch { fresh = new Map(); }
    for (const row of todo) {
      const net = fresh.get(row.number) ?? { ok: false, reason: 'not read' };
      out.set(row.number, net);
      if (net.ok) { memo.set(`${row.number}:${row.headRefOid}:${tip}`, net); if (memo.size > 1000) memo.delete(memo.keys().next().value); }
    }
  }
  return out;
}

/** Each open PR's head sha, from one `git ls-remote` (no GitHub API budget). Map(prNumber → sha); empty on failure. */
export function readPrHeads(dir, numbers, { run = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 60e3, stdio: ['ignore', 'pipe', 'pipe'] }) } = {}) {
  const heads = new Map();
  const wanted = [...new Set(numbers.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!wanted.length) return heads;
  try {
    const raw = run(['ls-remote', '--end-of-options', 'origin', ...wanted.map((n) => `refs/pull/${n}/head`)]);
    for (const line of String(raw).split('\n')) {
      const m = /^([0-9a-f]{40})\trefs\/pull\/(\d+)\/head$/.exec(line.trim());
      if (m) heads.set(Number(m[2]), m[1]);
    }
  } catch { /* fail open: no heads, no rewrite */ }
  return heads;
}

/**
 * The fix daemon's hook: rewrite the reconcile result's fences to git net sets when `fixOverlap` is on. FAILS OPEN.
 * Only the Web Everything repo is read (the git root is this clone); other repos pass through.
 */
export function applyNetScopeToReconcile(reconciled, { root, repoKey = 'we', env = process.env, settings = resolveNetScopeSettings(env),
  readHeads = readPrHeads, readNets = readNetSets } = {}) {
  try {
    if (!settings.fixOverlap || repoKey !== 'we' || !reconciled) return reconciled;
    const numbers = [...(reconciled.dispatch ?? []).map((e) => e?.prNumber), ...(reconciled.openPrFiles ?? []).map((r) => r?.pr)];
    const known = new Map((reconciled.dispatch ?? []).filter((e) => e?.headRefOid).map((e) => [Number(e.prNumber), e.headRefOid]));
    const missing = numbers.filter((n) => !known.has(Number(n)));
    const heads = new Map([...readHeads(root, missing), ...known]);
    const rows = [...heads].map(([number, headRefOid]) => ({ number, headRefOid }));
    return withNetFences(reconciled, readNets(rows, { dir: root }));
  } catch { return reconciled; }
}
