/**
 * git-fetch-fresh.mjs — ONE shared, freshness-aware `git fetch` for every caller that needs a recent remote ref.
 *
 * Why: ~12 independent callers fetched with no coalescing and every lane carried ~1 060 remote branches
 * (perf-2026-11-01 B-churn #4: fetch = 23 % of git time). Now a caller asks for the branches it needs:
 *   fetchFresh({ cwd, branches: ['main'] })              -> `git fetch origin +refs/heads/main:refs/remotes/origin/main`
 *   fetchFresh({ cwd, branches: ['main', 'lane/x'] })    -> exactly those two refspecs, never all ~1 060
 *   fetchFresh({ cwd, branches: null })                  -> plain `git fetch origin` (wide; throttled per clone only)
 *
 * Freshness window N (default 60 s). A decision that needs current main sees a fetch at most N s old.
 *   Policy cascade: standard 60 s -> platform `gitFetchFresh` -> tool `scripts/settings/git-fetch-fresh.json`
 *   -> env `WE_GIT_FETCH_FRESH_SECONDS` (0 = always fetch; max 3600).
 * Sharing: a narrow fetch is keyed by the OBJECT STORE (the alternates target when a lane borrows one, else the
 * clone's own store) + remote's effective URL + refspecs, so lanes that share an alternate share freshness. Refs are per clone,
 * so a skip never trusts the stamp blindly: the stamp records the sha each ref had after the real fetch, and the
 * skipping clone fast-forwards its own ref to it (object present, ancestor-only, never regresses). If it cannot
 * honour the stamp it does the real fetch. A FAILED fetch is never stamped.
 * Stamps: `$WE_GIT_FETCH_STAMP_DIR` or `<tmpdir>/we-git-fetch-stamps-<uid>`. Skips leave FETCH_HEAD untouched, so
 * callers read the tracking ref (`origin/<branch>`), never FETCH_HEAD.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { cascadePolicy, platformPreference } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';

export const FETCH_FRESH_SECONDS_ENV = 'WE_GIT_FETCH_FRESH_SECONDS';
export const DEFAULT_FETCH_FRESH_SECONDS = 60;

export function resolveFetchFreshSettings({
  env = process.env, tool = readSettings().gitFetchFresh, platform = platformPreference('gitFetchFresh', { env }),
} = {}) {
  const raw = env[FETCH_FRESH_SECONDS_ENV];
  return cascadePolicy('gitFetchFresh', tool, {
    standard: { maxAgeSeconds: DEFAULT_FETCH_FRESH_SECONDS }, platform, env,
    envValues: { maxAgeSeconds: raw === undefined ? undefined : /^\d+$/.test(raw) ? Number(raw) : raw },
    valid: { maxAgeSeconds: (v) => Number.isSafeInteger(v) && v >= 0 && v <= 3600 },
  });
}

let memo = null;
function defaultMaxAgeMs(env) {
  if (env !== process.env) return resolveFetchFreshSettings({ env }).value.maxAgeSeconds * 1000;
  memo ??= resolveFetchFreshSettings().value.maxAgeSeconds * 1000;
  return memo;
}

const defaultRun = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });

/** The git dir of `cwd` (a worktree's `.git` file is followed), or null when it cannot be read. */
function commonGitDir(cwd) {
  try {
    const dot = join(cwd, '.git');
    if (statSync(dot).isDirectory()) return dot;
    const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, 'utf8'))?.[1]?.trim();
    if (!gitdir) return null;
    const dir = isAbsolute(gitdir) ? gitdir : resolve(cwd, gitdir);
    try { const c = readFileSync(join(dir, 'commondir'), 'utf8').trim(); return isAbsolute(c) ? c : resolve(dir, c); } catch { return dir; }
  } catch { return null; }
}

/** Object-store identity: the first alternate when the clone borrows one, else its own objects dir. */
export function objectStoreOf(cwd) {
  const git = commonGitDir(cwd);
  if (!git) return null;
  const objects = join(git, 'objects');
  try {
    const first = readFileSync(join(objects, 'info', 'alternates'), 'utf8').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
    if (first) return resolve(objects, first);
  } catch { /* no alternates */ }
  return objects;
}

/** The window (ms) a caller's own cache must not outlive. */
export const fetchFreshWindowMs = (env = process.env) => defaultMaxAgeMs(env);

/** Effective fetch configuration through the fetch runner; null disables reuse when unprovable. */
export function fetchFreshRemoteIdentity(cwd, remote = 'origin', run = defaultRun) {
  try {
    const git = commonGitDir(cwd);
    const text = readFileSync(join(git, 'config'), 'utf8');
    // Includes and url rewrites change the effective destination: identity cannot be established from this file.
    if (/^\s*\[include|insteadOf/mi.test(text)) return null;
    // Git applies system/global/XDG/includes and environment or runner-supplied overrides here,
    // including url.*.insteadOf. Use the SAME runner as fetch, not a separate process environment.
    const url = String(run(['remote', 'get-url', remote], cwd) ?? '').replace(/\r?\n$/, '');
    if (!url) return null;
    // Some caller runners trim output. NUL-terminated config preserves significant URL whitespace,
    // and also keys changes to other fetch configuration (e.g. a wide fetch's configured refspecs).
    const config = String(run(['config', '--null', '--list', '--includes'], cwd) ?? '');
    if (!config.endsWith('\0')) return null;
    // A relative url means a different repository per clone location.
    const destination = /^([a-z][a-z0-9+.-]*:\/\/|[^/@:]+@[^/:]+:|\/)/i.test(url) ? url : `${resolve(cwd)}|${url}`;
    return identityKey([destination, config]);
  } catch { return null; }
}

export const refspecFor = (remote, branch) => `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`;
const trackingRef = (remote, branch) => `refs/remotes/${remote}/${branch}`;

function stampPath(dir, key) { return join(dir, `${key}.json`); }
const identityKey = (parts) => createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
function readStamp(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } }
function writeStamp(path, value) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, path);
  } catch { /* a stamp is an optimisation: an unwritable dir just means every call fetches */ }
}

function refShas(run, cwd, refs) {
  const out = String(run(['for-each-ref', '--format=%(refname) %(objectname)', ...refs], cwd) ?? '');
  return Object.fromEntries(out.split('\n').map((l) => l.trim().split(' ')).filter((p) => p.length === 2));
}

/** Bring this clone's tracking refs to the stamped shas without the network. False when it cannot be done safely. */
function applyStamp(run, cwd, stamped, refs) {
  if (!refs.length || refs.some((ref) => !/^[0-9a-f]{40,64}$/.test(stamped[ref] ?? ''))) return false; // an incomplete stamp proves nothing
  const local = refShas(run, cwd, refs);
  for (const ref of refs) {
    const want = stamped[ref];
    if (local[ref] === want) continue;
    try {
      run(['cat-file', '-e', `${want}^{commit}`], cwd);
      if (local[ref]) run(['merge-base', '--is-ancestor', local[ref], want], cwd);
      run(['update-ref', ref, want, local[ref] ?? '0'.repeat(want.length)], cwd); // old value pinned: a racing writer fails us into a real fetch
    } catch { return false; }
  }
  return true;
}

/**
 * Fetch `branches` from `remote` unless the same fetch ran within the window. Throws what git throws on a failed
 * fetch (callers keep their own catch/retry). Returns `{ fetched, skipped, key, ageMs }`.
 */
export function fetchFresh({
  cwd, remote = 'origin', branches = ['main'], noTags = false, maxAgeMs, env = process.env,
  run = defaultRun, now = Date.now, stampDir = env.WE_GIT_FETCH_STAMP_DIR || join(tmpdir(), `we-git-fetch-stamps-${process.getuid?.() ?? 'u'}`),
} = {}) {
  const narrow = Array.isArray(branches);
  const window = maxAgeMs ?? defaultMaxAgeMs(env);
  const specs = narrow ? [...new Set(branches)].sort().map((b) => refspecFor(remote, b)) : [];
  const refs = narrow ? [...new Set(branches)].sort().map((b) => trackingRef(remote, b)) : [];
  const identity = fetchFreshRemoteIdentity(cwd, remote, run);
  const scope = identity === null ? null : narrow ? objectStoreOf(cwd) : (commonGitDir(cwd) && resolve(cwd));
  const key = scope ? identityKey([scope, remote, identity, noTags ? 'nt' : 't', ...specs]) : null;
  const path = key ? stampPath(stampDir, key) : null;
  const fetchArgs = ['fetch', '--quiet', ...(noTags ? ['--no-tags'] : []), remote, ...specs];

  if (path && window > 0) {
    const stamp = readStamp(path);
    const age = stamp ? now() - stamp.at : Infinity;
    if (stamp && age >= 0 && age < window) {
      let honoured = false;
      try {
        // A wide fetch cannot restore refs. On A -> B -> A, A's old stamp is unsafe if B
        // changed any refs. Comparing the full snapshot detects ref changes since the stamp.
        honoured = narrow ? applyStamp(run, cwd, stamp.refs ?? {}, refs)
          : stamp.key === key && JSON.stringify(refShas(run, cwd, refs)) === JSON.stringify(stamp.refs);
      } catch { honoured = false; }
      if (honoured) return { fetched: false, skipped: true, key, ageMs: age };
    }
  }
  const at = now();
  run(fetchArgs, cwd); // a throw leaves any previous stamp alone and writes nothing: a failure is never cached
  if (path) {
    let shas;
    try { shas = refShas(run, cwd, refs); } catch { shas = null; }
    if (shas && refs.every((ref) => shas[ref])) writeStamp(path, { at, remote, key, refs: shas });
  }
  return { fetched: true, skipped: false, key, ageMs: 0 };
}
