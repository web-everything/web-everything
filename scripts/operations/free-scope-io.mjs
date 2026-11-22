/**
 * @file scripts/operations/free-scope-io.mjs
 * @description IMPURE snapshot and registry boundary for free-scope. GitHub, YAML, clock and filesystem
 * reads live here; atomic locked updates keep concurrent workers from overwriting one another's scopes.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { runGhSync } from '../lib/gh-throttle.mjs';
import { withPathLock } from '../readiness/with-lock.mjs';
import { cascadePolicy } from '../lib/policy-cascade.mjs';
import { DEFAULT_REPOS, GH_LIST_FILE_CAP, choosePrFileSet, qualifyFile, repoKeyFor } from './free-scope.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
const matter = createRequire(import.meta.url)('gray-matter');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export function defaultRegistryPath(env = process.env) {
  return env.WE_AGENT_SCOPES_PATH || path.join(os.homedir(), 'workspace/.operations/coordination/agent-scopes.json');
}
/** Standard heartbeat window for an entry registered with `--heartbeat`. */
export const STANDARD_FREE_SCOPE_SETTINGS = Object.freeze({ staleAfterMinutes: 45 });
export const STALE_AFTER_MINUTES_ENV = 'WE_FREE_SCOPE_STALE_AFTER_MINUTES';
const positive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
/**
 * Resolve `freeScope.staleAfterMinutes` standard -> platform -> env through the shared cascade, which logs the
 * effective value and its source. Any invalid layer is refused, never silently replaced by a lower one.
 */
export function resolveFreeScopeSettings({ env = process.env, platform, log } = {}) {
  const raw = env?.[STALE_AFTER_MINUTES_ENV];
  const envValues = raw === undefined ? {} : { staleAfterMinutes: raw.trim() === '' ? NaN : Number(raw) };
  const resolved = cascadePolicy('freeScope', undefined, { standard: STANDARD_FREE_SCOPE_SETTINGS, envValues,
    valid: { staleAfterMinutes: positive }, env, ...(platform !== undefined ? { platform } : {}), ...(log ? { log } : {}) });
  if (resolved.invalid.length) throw new TypeError(`free-scope: invalid staleAfterMinutes setting: ${resolved.invalid.join('; ')}`);
  return { staleAfterMinutes: resolved.value.staleAfterMinutes, source: resolved.sources.staleAfterMinutes };
}
/** `required: true` makes a missing registry an error: absence then proves nothing about who holds a scope. */
export function readRegistry(file, { required = false } = {}) {
  let source;
  try { source = fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') {
      if (required) throw new Error(`free-scope: registry ${file} does not exist (set WE_AGENT_SCOPES_PATH, or create it as {"entries":[]})`);
      return [];
    }
    throw error;
  }
  try {
    const parsed = JSON.parse(source);
    const entries = Array.isArray(parsed) ? parsed : parsed?.entries;
    if (!Array.isArray(entries)) throw new Error('expected an array or { entries: [] }');
    return entries;
  } catch (error) { throw new Error(`free-scope: cannot read registry ${file}: ${error.message}`); }
}
export function writeRegistry(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try { fs.writeFileSync(temp, `${JSON.stringify({ entries }, null, 2)}\n`); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}
/** Serialize a read-modify-write of the registry through the repo's lock primitive (`scripts/readiness/file-locks.mjs`). */
export function updateRegistry(file, fn) {
  return withPathLock(file, ({ touch }) => {
    const entries = fn(readRegistry(file));
    touch(); // still ours? Then commit.
    writeRegistry(file, entries);
    return entries;
  });
}
export function ghExec(env = process.env) {
  return (args) => env.WE_FREE_SCOPE_GH_BIN
    ? execFileSync(env.WE_FREE_SCOPE_GH_BIN, args, { encoding: 'utf8' })
    : runGhSync(args, { encoding: 'utf8' });
}
/** `gh pr list --limit` page size. A page this full may have been cut off, so it is never trusted as complete. */
export const OPEN_PR_LIMIT = 200;
/** `gh pr list --json files` lists at most this many files per PR; a PR at the cap may touch more than it shows. */
export const PR_FILES_LIMIT = GH_LIST_FILE_CAP;
const SHA = /^[0-9a-f]{40}$/;
/** One line naming why a subprocess failed: its own stderr when it wrote one, else the error message. */
const firstLine = (error) => String(error?.stderr || '').trim().split(/\r?\n/)[0] || String(error?.message || error).split(/\r?\n/)[0];
/** Run git in `dir`. Large PRs list thousands of paths, so the buffer is generous. */
export function gitExec() {
  return (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024, timeout: 120e3 });
}
/** The local checkout whose `origin` is `repo`, or null. WE is the checkout running this script (`root`). */
export function defaultGitDirFor(repo, { root = repoRoot, env = process.env } = {}) {
  const key = repoKeyFor(repo);
  if (key === 'we') return root;
  const meta = CONSTELLATION_REPOS[key];
  if (!meta?.path) return null;
  const dir = meta.path.replace(/^\$HOME(?=\/|$)/, env.HOME || os.homedir());
  return fs.existsSync(path.join(dir, '.git')) ? dir : null;
}
/**
 * Each PR's NET file set from git (xl5oele): the head commit against its merge-base with current `<remote>/<base>`.
 * One fetch brings `<base>` up to date plus every PR head not already present (by `refs/pull/<n>/head`, no ref or
 * FETCH_HEAD written). A failed fetch is not fatal: heads already present are still diffed, and a stale base only
 * widens a set (never narrows it). Returns Map(number → { ok, files, added } | { ok: false, reason }).
 */
/** A branch name safe to pass to git as a ref: no leading dash, no `..`, no glob or control characters. */
const SAFE_BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]+$/;
/**
 * `perRowBase` (the open-PR reader): each PR is diffed against ITS OWN base branch (`row.baseRefName`), never an assumed
 * `base`: a stacked PR can match main yet differ from the branch it targets. A row without a usable base name is
 * unreadable by git (the caller falls back and fails closed), never diffed against main.
 * `readOnly` (check-scope): no ref is created or moved and FETCH_HEAD is not written. The base tip comes from
 * `ls-remote` and is fetched by id; when that read fails, an existing local `<remote>/<base>` ref is used, which can
 * only be older, and an older base only widens a set. The caller's `git` should also keep fetched objects out of the repo.
 */
export function readNetFileSets({ dir, rows, git, remote = 'origin', base = 'main', perRowBase = false, readOnly = false }) {
  const out = new Map();
  const fail = (row, reason) => out.set(row.number, { ok: false, reason });
  if (!dir) { for (const row of rows) fail(row, 'no local checkout of this repo'); return out; }
  const baseOf = (row) => (perRowBase ? row.baseRefName : base);
  const valid = rows.filter((row) => Number.isInteger(row.number) && row.number > 0 && SHA.test(String(row.headRefOid || ''))
    && typeof baseOf(row) === 'string' && SAFE_BRANCH.test(baseOf(row)));
  for (const row of rows) if (!valid.includes(row)) fail(row, SHA.test(String(row.headRefOid || '')) ? 'no usable base branch' : 'no usable head commit id');
  if (!valid.length) return out;
  const present = (sha) => { try { git(dir, ['cat-file', '-e', `${sha}^{commit}`]); return true; } catch { return false; } };
  const missing = valid.filter((row) => !present(row.headRefOid));
  const bases = [...new Set(valid.map(baseOf))];
  // What each base is diffed against: the remote-tracking ref (writing mode), or the tip id read from the remote (read-only).
  const against = new Map();
  const wants = [];
  if (readOnly) {
    for (const name of bases) {
      let tip = null;
      // `ls-remote` matches its pattern as a TAIL, so `refs/heads/main` also lists `refs/heads/refs/heads/main`: only the exact ref counts.
      try {
        const lines = String(git(dir, ['ls-remote', '--exit-code', '--end-of-options', remote, `refs/heads/${name}`])).split(/\r?\n/);
        const exact = lines.map((line) => line.split('\t')).filter(([, ref]) => ref === `refs/heads/${name}`);
        if (exact.length === 1) tip = exact[0][0];
      } catch { /* use the local ref */ }
      if (tip && SHA.test(tip)) { against.set(name, tip); if (!present(tip)) wants.push(tip); } else against.set(name, `${remote}/${name}`);
    }
  } else for (const name of bases) against.set(name, `${remote}/${name}`);
  const wanted = [...(readOnly ? wants : bases.map((name) => `+refs/heads/${name}:refs/remotes/${remote}/${name}`)), ...missing.map((row) => `refs/pull/${row.number}/head`)];
  // A fetch with no refspec would apply the remote's default one and move refs, so a read-only run with nothing to fetch skips it.
  if (wanted.length) {
    // Read-only: no auto-gc or maintenance and no submodule recursion, so the fetch touches nothing but the quarantine.
    const prefix = readOnly ? ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false'] : [];
    try { git(dir, [...prefix, 'fetch', '--quiet', '--no-write-fetch-head', ...(readOnly ? ['--no-recurse-submodules'] : []), '--end-of-options', remote, ...wanted]); }
    catch { /* offline or a head gone: diff whatever is present; the rest falls back below */ }
  }
  for (const row of valid) {
    try {
      const mergeBase = String(git(dir, ['merge-base', '--end-of-options', against.get(baseOf(row)), row.headRefOid])).split('\n')[0].trim();
      if (!SHA.test(mergeBase)) throw new Error('no merge-base with the base branch');
      // --no-renames: a rename holds both its old and new path. -z: paths are NUL-separated, never quoted.
      const raw = String(git(dir, ['diff', '--no-ext-diff', '--no-renames', '--name-status', '-z', '--end-of-options', mergeBase, row.headRefOid]));
      // Remove only the final record terminator. Filtering empty tokens hides corrupt records, and a missing
      // final NUL can be a truncated filename even when the remaining token count is even.
      if (raw && !raw.endsWith('\0')) throw new Error('git diff output is incomplete (missing final terminator)');
      const tokens = raw ? raw.slice(0, -1).split('\0') : [];
      const files = [], added = [];
      // A truncated or corrupt `-z` stream must never become a shorter file set: an odd token count or an unknown status is unreadable.
      if (tokens.length % 2 !== 0) throw new Error('git diff output is incomplete (odd token count)');
      for (let i = 0; i < tokens.length; i += 2) {
        if (!/^[ADMTUXB]$/.test(tokens[i])) throw new Error(`git diff output has an unknown status "${String(tokens[i]).slice(0, 8)}"`);
        if (!tokens[i + 1]) throw new Error('git diff output has an empty path');
        files.push(tokens[i + 1]);
        if (tokens[i] === 'A') added.push(tokens[i + 1]);
      }
      out.set(row.number, { ok: true, files, added });
    } catch (error) { fail(row, firstLine(error)); }
  }
  return out;
}
/** `status` values GitHub's PR files API documents; any other value is an unknown row shape and unreadable. */
const API_STATUSES = new Set(['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged']);
/** `changeType` values `gh pr list --json files` documents; a file without one cannot be told apart from a rename. */
const LIST_CHANGE_TYPES = new Set(['ADDED', 'CHANGED', 'COPIED', 'DELETED', 'MODIFIED', 'RENAMED']);
/** GitHub's paginated files API for one PR (up to GH_API_FILE_CAP files). A rename holds both paths. */
export function readPagedFiles({ repo, number, exec }) {
  try {
    const raw = exec(['api', '--paginate', `repos/${repo}/pulls/${number}/files?per_page=100`,
      '--jq', '.[] | {s: .status, f: .filename, p: .previous_filename}']);
    const files = [], added = [];
    for (const line of String(raw).split(/\r?\n/).filter((l) => l.trim())) {
      const row = JSON.parse(line);
      if (!row || typeof row.f !== 'string' || !row.f || typeof row.s !== 'string' || !API_STATUSES.has(row.s)) throw new Error('unexpected files API row');
      const previous = typeof row.p === 'string' && row.p ? row.p : null;
      // A rename holds both paths; a rename row without the old one is incomplete evidence, never a destination-only answer.
      if (row.s === 'renamed' && !previous) throw new Error('files API renamed row has no previous_filename');
      files.push(row.f);
      if (previous) files.push(previous);
      if (row.s === 'added') added.push(row.f);
    }
    return { ok: true, files, added };
  } catch (error) { return { ok: false, reason: firstLine(error) }; }
}
/**
 * A `git` that keeps everything it fetches OUT of the repository: objects land in a throwaway directory and the
 * repository's own object store is only an alternate to read from. Together with `readNetFileSets({ readOnly })`,
 * which creates no ref and no FETCH_HEAD, a read-only caller leaves the checkout exactly as it found it.
 * Call `.cleanup()` when done.
 */
export function gitExecQuarantined() {
  const quarantines = new Map();
  const quarantineFor = (dir) => {
    let found = quarantines.get(dir);
    if (!found) {
      const common = String(execFileSync('git', ['-C', dir, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024, timeout: 30e3 })).trim();
      found = { objects: fs.mkdtempSync(path.join(os.tmpdir(), 'free-scope-objects-')), alternate: path.resolve(dir, common, 'objects') };
      quarantines.set(dir, found);
    }
    return found;
  };
  const run = (dir, args) => {
    const { objects, alternate } = quarantineFor(dir);
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: 120e3,
      env: { ...process.env, GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: alternate } });
  };
  run.cleanup = () => { for (const { objects } of quarantines.values()) fs.rmSync(objects, { recursive: true, force: true }); quarantines.clear(); };
  return run;
}
export function readOpenPrs({ repos = DEFAULT_REPOS, exec, readOnly = false, git = readOnly ? gitExecQuarantined() : gitExec(), gitDirFor = (repo) => defaultGitDirFor(repo) }) {
  try { return readOpenPrsWith({ repos, exec, readOnly, git, gitDirFor }); } finally { git.cleanup?.(); }
}
function readOpenPrsWith({ repos, exec, readOnly, git, gitDirFor }) {
  const prs = [], unreadable = [];
  for (const repo of repos) {
    try {
      const rows = JSON.parse(exec(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(OPEN_PR_LIMIT), '--json', 'number,title,url,headRefOid,baseRefName,files']));
      const net = readNetFileSets({ dir: gitDirFor(repo), rows, git, perRowBase: true, readOnly });
      const why = [];
      if (rows.length >= OPEN_PR_LIMIT) why.push(`open PR list hit the ${OPEN_PR_LIMIT}-row limit and may be truncated`);
      for (const { number, title, url, files: listedFiles } of rows) {
        // A row with no `files` array (or a malformed entry) is incomplete evidence, never an empty change set.
        // `changeType` is required too: without it a rename cannot be told from an edit, so its previous path would be missed.
        const wellFormed = Array.isArray(listedFiles) && listedFiles.every((f) => f && typeof f.path === 'string' && f.path
          && typeof f.changeType === 'string' && LIST_CHANGE_TYPES.has(f.changeType));
        const entries = wellFormed ? listedFiles : [];
        // The list names only a rename's NEW path; its previous path is a file the PR also holds, and only the paged API reports it.
        const hasRename = entries.some((f) => f.changeType === 'RENAMED');
        // An EMPTY list is unverified too: no PR changes nothing, so it is what an unpopulated response looks like.
        const listed = { ok: wellFormed && !hasRename && entries.length > 0, files: entries.map((f) => f.path), added: entries.filter((f) => f.changeType === 'ADDED').map((f) => f.path),
          reason: !wellFormed || !entries.length ? 'the PR list gave no usable files' : 'the PR list omits a renamed file\'s previous path' };
        const netRead = net.get(number);
        // The paginated API costs one call per PR, so only ask it when git failed AND the cheap list is capped or unusable.
        const paged = !netRead?.ok && (!listed.ok || listed.files.length >= GH_LIST_FILE_CAP) ? readPagedFiles({ repo, number, exec }) : undefined;
        const choice = choosePrFileSet({ net: netRead, paged, listed });
        // An unresolved PR still holds every file it listed, but the snapshot is incomplete: never "free".
        const { files, added } = choice.source ? choice : listed;
        if (!choice.source) why.push(`PR #${number} ${choice.reason}`);
        // `added` (only when non-empty): the files this PR creates. The assessor lets a brand-new backlog card through.
        prs.push({ repo, number, title, url, files, ...(added.length ? { added } : {}), source: choice.source || 'github-list-capped' });
      }
      if (why.length) unreadable.push({ repo, error: why.join('; ') });
    } catch (error) { unreadable.push({ repo, error: firstLine(error) }); }
  }
  // `repos` echoes what this read was asked to cover, so a caller can prove its declared repos were all in scope.
  return { prs, unreadable, repos: [...repos] };
}
export function findCardFile(card, { root }) {
  const id = String(card).replace(/^#/, '');
  if (!id || /[/\\]/.test(id)) return null;
  let names;
  try { names = fs.readdirSync(path.resolve(root, 'backlog')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const name = names.sort().find((n) => n.startsWith(`${id}-`) && n.endsWith('.md'));
  return name ? path.resolve(root, 'backlog', name) : null;
}
/** gray-matter's executable engines, each replaced by one that refuses (same guard as probation-build-run.mjs, #4291). */
const REFUSE_ENGINE = () => { throw new Error('executable frontmatter refused'); };
const NO_EXEC_ENGINES = Object.freeze({ js: REFUSE_ENGINE, javascript: REFUSE_ENGINE, coffee: REFUSE_ENGINE, coffeescript: REFUSE_ENGINE, cson: REFUSE_ENGINE });
export function readCardScope(card, { root }) {
  const file = findCardFile(card, { root });
  if (!file) throw new Error(`free-scope: card ${card} not found`);
  const text = fs.readFileSync(file, 'utf8');
  // gray-matter's default engines `eval` a `---js` block, and a card may come from an unreviewed PR checkout.
  if (!/^---\r?\n/.test(text)) throw new Error(`free-scope: card ${card} front matter is not a plain YAML block`);
  const scope = matter(text, { language: 'yaml', engines: NO_EXEC_ENGINES }).data.scope;
  const entries = scope == null ? [] : Array.isArray(scope) ? scope : [scope];
  if (!entries.length || entries.some((e) => typeof e !== 'string' || !e.trim())) throw new Error(`free-scope: card ${card} has no scope of strings`);
  return entries;
}
export function collectFreeScope({ files = '', card = '', root = repoRoot, repos = DEFAULT_REPOS,
  env = process.env, now = Date.now, exec = ghExec(env), registryPath = defaultRegistryPath(env), requireRegistry = false,
  readOnly = false, git = readOnly ? gitExecQuarantined() : gitExec(), gitDirFor = (repo) => defaultGitDirFor(repo, { root, env }) } = {}) {
  const scope = [...new Set([...files.split(','), ...(card ? readCardScope(card, { root }) : [])].map((f) => qualifyFile(f)).filter(Boolean))];
  if (!scope.length) throw new TypeError('free-scope: give --files=a,b or --card=<id>');
  return { files: scope, nowMs: now(), ...readOpenPrs({ repos, exec, git, gitDirFor, readOnly }), agents: readRegistry(registryPath, { required: requireRegistry }) };
}
