/**
 * @file scripts/lib/git-hook-surface.mjs
 * @description Hardening primitive for `we:scripts/operations/probation-heal-run.mjs` and
 *   `we:scripts/operations/probation-build-run.mjs` (backlog `x55dojc`): both run an untrusted model with
 *   filesystem write access inside a real git lane clone, then run `git commit` (and, later, the gate,
 *   `verify-lane.mjs`, which itself shells out to git) in that SAME lane. Nothing there previously disabled or
 *   even inspected git hooks, so a hostile or mistaken worker could plant `.git/hooks/pre-commit` (or a
 *   `core.hooksPath` repoint), which then executes with the launcher's own credentials at commit/gate time.
 *
 * SCOPE, STATED EXPLICITLY (a 2026-09-28 Codex plan review flagged this as the one thing worth being honest
 * about): this covers the TRADITIONAL git-hooks mechanism (`.git/hooks/<name>`, `core.hooksPath`) only. It does
 * NOT cover every config-controlled execution path git supports (`core.fsmonitor`, `clean`/`smudge`/`textconv`
 * filters named in `.gitattributes`+config, or the newer `hook.<name>.command`/`.event` config-hooks upstream
 * git added after this was written) — those are a materially different, broader hardening pass, tracked as a
 * separate follow-up rather than half-covered here under this item's name.
 *
 * THE TWO LAYERS:
 *   1. PREVENTION — {@link HOOKS_DISABLED_ENV}/{@link withHooksDisabled}: env-based git config
 *      (`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`, git >=2.31) outranks a repo's own
 *      `.git/config`, so pointing `core.hooksPath` at `/dev/null` (not a directory — git finds no hook file
 *      under it and silently treats every hook as absent) via this env disables hooks for EVERY git command
 *      that inherits it, even one a worker's own re-write of `.git/config` tries to re-enable. Apply it to
 *      every subprocess the run script ITSELF runs in the lane (commit, gate, resolve, push, …) — NOT to the
 *      worker or checker process (#4291 advisory review): a hook the worker plants and then runs itself gains
 *      it nothing, while the override would switch off the repo's own `.githooks/pre-push` main-push guard — a
 *      guard against a worker's MISTAKE (not a security boundary: a hostile worker can bypass any hook).
 *   2. DETECTION + CLEANUP — {@link resetHookSurface} (force a known-clean baseline before a worker ever runs,
 *      so a PREVIOUS dispatch's leftovers in a reused pooled lane are never silently inherited) and
 *      {@link snapshotHookSurface}/{@link hookSurfaceChanged} (did anything change while the worker ran? loudly
 *      refuse and re-clean if so — belt-and-suspenders in case layer 1 is ever bypassed by a future refactor
 *      that forgets to apply the env, or by a hostile child that unsets its own inherited env and calls
 *      `git -c core.hooksPath=<real path>` explicitly — an explicit `-c` DOES outrank the inherited env).
 *
 * withHooksDisabled probes Git synchronously and throws on initialization refusal. Snapshot/reset cleanup
 * calls retain their no-throw contracts and documented FAIL-CLOSED defaults (an unreadable snapshot reads
 * as "changed") for callers that are often already inside their own cleanup/refusal path.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Zero-entry compatibility template; alone it does not check the Git prerequisite or preserve counted
 * caller entries. Use withHooksDisabled for initialization. See the file header for why
 * env-based config, not a per-call `-c` flag, is what makes this survive a worker rewriting `.git/config`.
 */
export const HOOKS_DISABLED_ENV = Object.freeze({
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'core.hooksPath',
  GIT_CONFIG_VALUE_0: '/dev/null',
});

/**
 * Return a fresh environment with core.hooksPath appended after all caller counted entries.
 * Synchronously probes Git through this appended environment (preserving the supplied PATH), without caching
 * success. Even the prerequisite probe inherits the traditional-hook override.
 * @param {Record<string,string>} [env]
 * @returns {Record<string,string>}
 * @throws {Error} Initialization refusal for invalid counted configuration or unprobeable/unsupported Git.
 *   Diagnostics omit configuration values and subprocess output. Cleanup contracts are unchanged.
 */
export function withHooksDisabled(env = {}) {
  const rawCount = env.GIT_CONFIG_COUNT;
  const count = rawCount === undefined || rawCount === '' ? 0 : Number(rawCount);
  if ((rawCount !== undefined && rawCount !== '' && (typeof rawCount !== 'string' || /[^0-9]/.test(rawCount)))
    || !Number.isSafeInteger(count) || count < 0 || count >= 2147483647) {
    throw new Error('Hook protection initialization refused: invalid GIT_CONFIG_COUNT (must leave room for one signed-int entry)');
  }
  for (let i = 0; i < count; i++) {
    for (const field of ['KEY', 'VALUE']) {
      const name = `GIT_CONFIG_${field}_${i}`;
      if (typeof env[name] !== 'string') {
        throw new Error(`Hook protection initialization refused: missing or invalid ${name}`);
      }
    }
  }

  const protectedEnv = { ...env, GIT_CONFIG_COUNT: String(count + 1),
    [`GIT_CONFIG_KEY_${count}`]: 'core.hooksPath', [`GIT_CONFIG_VALUE_${count}`]: '/dev/null' };
  let version;
  try {
    version = execFileSync('git', ['--version'], {
      env: protectedEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 4096, shell: false,
    });
  } catch {
    throw new Error('Hook protection initialization refused: Git version probe failed (requires Git >=2.31.0)');
  }
  // Anchor the entire output: prereleases, extra lines and unknown suffixes are ambiguous.
  const match = /^git version ([0-9]+)\.([0-9]+)\.([0-9]+)(?: \(Apple Git-[0-9]+\)|\.windows\.[0-9]+)?(?:\r?\n)?$/.exec(version);
  const parts = match?.slice(1, 4).map(Number);
  if (!parts || match[0].length !== version.length || !parts.every(Number.isSafeInteger)
    || !(parts[0] > 2 || (parts[0] === 2 && parts[1] >= 31))) {
    throw new Error('Hook protection initialization refused: requires a stable Git >=2.31.0 version');
  }
  return protectedEnv;
}

/** A stable fingerprint for one `.git/hooks/` entry: type + permission bits + content (files) or link target
 *  (symlinks), so a chmod, a content edit, and a symlink swap are all visible as a changed value — not just a
 *  content-hash miss that a mode-only or symlink-shaped plant would slip past. Never throws: an entry that
 *  vanishes or becomes unreadable between the `readdir` and this read fingerprints as `'gone'`. */
function fingerprintEntry(path) {
  let st;
  try { st = lstatSync(path); } catch { return 'gone'; }
  const mode = st.mode.toString(8);
  if (st.isSymbolicLink()) {
    let target = '(unreadable)';
    try { target = readlinkSync(path); } catch { /* keep the placeholder */ }
    return `symlink:${mode}:${target}`;
  }
  if (st.isFile()) {
    try {
      const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
      return `file:${mode}:${hash}`;
    } catch { return `file:${mode}:(unreadable)`; }
  }
  return `other:${mode}`;
}

/**
 * Read a lane's hook-plantable surface right now: a fingerprint of every entry directly under
 * `.git/hooks/`, plus a sha256 of the WHOLE `.git/config` file's text (not a parsed `hooksPath` line — a
 * single parsed line misses a duplicate/case-varied entry, an `[include]`/`includeIf`, or an unrelated new
 * `hook.<name>.command` entry a newer git might read; hashing the whole file catches any of those as "the
 * config changed", which is all the DETECTION layer needs — see the file header for why the PREVENTION layer
 * stays explicitly scoped to `core.hooksPath`). Read as plain file text, never through a `git config` query,
 * which would inherit {@link HOOKS_DISABLED_ENV} (when the caller applies it) and always answer the overridden
 * value regardless of what is actually on disk.
 *
 * Never throws: a missing `.git/hooks/` reads as `{}` (not itself suspicious — a fresh/shallow clone may have
 * none); a missing/unreadable `.git/config` reads `configHash: null`.
 *
 * `configBytes` carries the file itself (raw bytes, so a restore is byte-exact), so a caller can hand this
 * snapshot back to {@link resetHookSurface} as the baseline to restore after a detected tamper (#4291 advisory
 * finding). It may hold credentials (a remote URL with a token): never log or serialize a snapshot.
 * @param {string} dir - the lane's own checkout root (NOT `.git` itself).
 * @returns {{configHash: string|null, configBytes: Buffer|null, files: Record<string,string>}}
 */
export function snapshotHookSurface(dir) {
  const files = {};
  try {
    const hooksDir = join(dir, '.git', 'hooks');
    for (const name of readdirSync(hooksDir)) {
      files[name] = fingerprintEntry(join(hooksDir, name));
    }
  } catch { /* no .git/hooks/ at all — files stays {} */ }
  let configHash = null;
  let configBytes = null;
  try {
    configBytes = readFileSync(join(dir, '.git', 'config'));
    configHash = createHash('sha256').update(configBytes).digest('hex');
  } catch { /* no .git/config — configHash stays null */ }
  return { configHash, configBytes, files };
}

/**
 * Did a lane's hook-plantable surface change between two {@link snapshotHookSurface} reads? PURE, fail-closed:
 * a missing `before`/`after` (a caller that skipped taking one) reads as changed — this must never be the
 * quiet default that waves a run through.
 * @param {{configHash: string|null, files: Record<string,string>}|null|undefined} before
 * @param {{configHash: string|null, files: Record<string,string>}|null|undefined} after
 * @returns {{changed: boolean, reason: string}}
 */
export function hookSurfaceChanged(before, after) {
  if (!before || !after) return { changed: true, reason: 'the hook surface could not be read (a before or after snapshot is missing)' };
  if ((before.configHash ?? null) !== (after.configHash ?? null)) {
    return { changed: true, reason: '.git/config changed (hooksPath, an include, or some other entry)' };
  }
  const beforeFiles = before.files ?? {};
  const afterFiles = after.files ?? {};
  const names = new Set([...Object.keys(beforeFiles), ...Object.keys(afterFiles)]);
  const added = [];
  const removed = [];
  const modified = [];
  for (const name of names) {
    const b = beforeFiles[name];
    const a = afterFiles[name];
    if (b === undefined) added.push(name);
    else if (a === undefined) removed.push(name);
    else if (b !== a) modified.push(name);
  }
  if (added.length || removed.length || modified.length) {
    const parts = [];
    if (added.length) parts.push(`added: ${added.join(', ')}`);
    if (removed.length) parts.push(`removed: ${removed.join(', ')}`);
    if (modified.length) parts.push(`modified: ${modified.join(', ')}`);
    return { changed: true, reason: `.git/hooks/ changed — ${parts.join('; ')}` };
  }
  return { changed: false, reason: 'unchanged' };
}

/** The repo's own tracked hooks directory, which `npm prepare` points `core.hooksPath` at. */
export const REPO_HOOKS_PATH = '.githooks';

/**
 * Put `core.hooksPath` back to the repo's own convention: `.githooks` when the repo TRACKS files there (what
 * `npm prepare` sets — `.githooks/pre-push` is the main-push guard), else unset. Read from the COMMITTED tree
 * (`ls-tree HEAD`), never the index: a `.githooks/` the worker created — even one it `git add`ed — is never
 * trusted. Returns whether the config write succeeded.
 */
function restoreRepoHooksPath(dir) {
  let tracked = false;
  try {
    tracked = execFileSync('git', ['-C', dir, 'ls-tree', '--name-only', 'HEAD', '--', REPO_HOOKS_PATH], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() !== '';
  } catch { return false; }
  try {
    if (tracked) execFileSync('git', ['-C', dir, 'config', 'core.hooksPath', REPO_HOOKS_PATH], { stdio: 'ignore' });
    else execFileSync('git', ['-C', dir, 'config', '--unset-all', 'core.hooksPath'], { stdio: 'ignore' });
    return true;
  } catch (e) {
    return !tracked && e?.status === 5; // `--unset-all` on a key that is not set exits 5 — already clean.
  }
}

/**
 * Force the lane's git-hook surface back to a known-safe baseline: delete every entry directly under
 * `.git/hooks/` that is not a `*.sample` file (git's own inert-template convention — these ship with every
 * `git init`/clone and are never executed), and put `core.hooksPath` in the lane's OWN `.git/config` back to
 * the repo's own tracked `.githooks/` (or unset it) — undoing a repoint, never pinning it off. #4291 advisory
 * review: an earlier draft pinned `/dev/null` here, which left a pooled lane's guard hooks (`pre-push`'s
 * main-push lock, `pre-commit`) silently off for whoever held the lane next. The launcher's own git calls are
 * kept hook-free by {@link HOOKS_DISABLED_ENV}, not by this on-disk value.
 *
 * Called BEFORE a worker ever runs (so a PREVIOUS dispatch's leftovers in a reused pooled lane can never be
 * silently inherited and blamed on the current run) and again after a detected tamper (so the lane is not left
 * poisoned for whoever uses it next). Best-effort and NEVER THROWS (every fs/git call here is try/caught) —
 * this is very often itself called from a caller already inside a cleanup/refusal path, where a throw would
 * skip the escalation/reporting that must still happen.
 *
 * `baseline` (#4291 advisory finding) — after a detected tamper, pass the pre-worker {@link snapshotHookSurface}:
 * the WHOLE `.git/config` is put back to its text first (a `core.fsmonitor`, `include.path` or alias the worker
 * added is gone, rather than hashed into the next dispatch's baseline). The file is removed and re-created, so a
 * `.git/config` symlink the worker planted is replaced, never written through.
 *
 * `.git`/`.git/hooks` MUST be real directories, never followed through (#4291 advisory review, security/security):
 * a worker sandboxed to the lane could replace either with a symlink pointing outside it, and the readdir+rmSync
 * cleanup below would otherwise recurse into and delete the LINK TARGET's contents with this (unsandboxed)
 * launcher's own permissions. Both are `lstatSync`'d BEFORE any read or write; if either exists and is not a
 * real directory, this returns `clean: false` immediately, touching neither path — a missing `.git` or
 * `.git/hooks` is not itself suspicious (a fresh/shallow clone may have neither yet) and falls through as usual.
 *
 * @param {string} dir
 * @param {{configBytes?: Buffer|null}} [baseline]
 * @returns {{clean: boolean, leftover: string[], snapshot: {configHash: string|null, configBytes: Buffer|null, files: Record<string,string>}}}
 *   `clean: false` means the cleanup could not fully complete (a leftover non-sample hook file, or the config
 *   write/restore failed) — a caller MUST treat that as "no safe baseline": refuse before running any worker,
 *   and after a tamper run no further git in the lane (not even the discard).
 */
export function resetHookSurface(dir, baseline) {
  for (const p of [join(dir, '.git'), join(dir, '.git', 'hooks')]) {
    let st;
    try { st = lstatSync(p); } catch { continue; } // missing is fine — nothing to protect yet, fall through
    if (!st.isDirectory()) {
      // A symlink (or a plain file) in place of a real directory — refuse without touching anything under it.
      return { clean: false, leftover: [], snapshot: { configHash: null, configBytes: null, files: {} } };
    }
  }
  let restoreOk = true;
  if (baseline?.configBytes != null) {
    const configPath = join(dir, '.git', 'config');
    try {
      rmSync(configPath, { force: true });
      writeFileSync(configPath, baseline.configBytes, { flag: 'wx' });
    } catch { restoreOk = false; }
  } else if (baseline && baseline.configBytes == null) {
    // The baseline was taken with no `.git/config` on disk at all (#4393) — a config a worker created from
    // nothing since then must not survive the reset. Only fires when a baseline was actually passed (the
    // pre-worker cleanup call site passes none at all, and must leave a pre-existing repo's own config alone).
    try { rmSync(join(dir, '.git', 'config'), { force: true }); } catch { restoreOk = false; }
  }
  try {
    const hooksDir = join(dir, '.git', 'hooks');
    for (const name of readdirSync(hooksDir)) {
      if (name.endsWith('.sample')) continue;
      try { rmSync(join(hooksDir, name), { force: true, recursive: true }); } catch { /* best-effort */ }
    }
  } catch { /* no .git/hooks/ at all — nothing to clean */ }
  const configOk = restoreRepoHooksPath(dir);
  const snapshot = snapshotHookSurface(dir);
  const leftover = Object.keys(snapshot.files).filter((name) => !name.endsWith('.sample'));
  return { clean: restoreOk && configOk && leftover.length === 0, leftover, snapshot };
}
