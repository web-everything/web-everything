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
import { DEFAULT_REPOS, GH_LIST_FILE_CAP, choosePrFileSet, qualifyFile, repoKeyFor } from './free-scope.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
const matter = createRequire(import.meta.url)('gray-matter');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export function defaultRegistryPath(env = process.env) {
  return env.WE_AGENT_SCOPES_PATH || path.join(os.homedir(), 'workspace/.operations/coordination/agent-scopes.json');
}
export function readRegistry(file) {
  let source;
  try { source = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
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
export function readNetFileSets({ dir, rows, git, remote = 'origin', base = 'main' }) {
  const out = new Map();
  const fail = (row, reason) => out.set(row.number, { ok: false, reason });
  if (!dir) { for (const row of rows) fail(row, 'no local checkout of this repo'); return out; }
  const valid = rows.filter((row) => Number.isInteger(row.number) && row.number > 0 && SHA.test(String(row.headRefOid || '')));
  for (const row of rows) if (!valid.includes(row)) fail(row, 'no usable head commit id');
  if (!valid.length) return out;
  const present = (sha) => { try { git(dir, ['cat-file', '-e', `${sha}^{commit}`]); return true; } catch { return false; } };
  const missing = valid.filter((row) => !present(row.headRefOid));
  try {
    git(dir, ['fetch', '--quiet', '--no-write-fetch-head', '--end-of-options', remote,
      `+refs/heads/${base}:refs/remotes/${remote}/${base}`, ...missing.map((row) => `refs/pull/${row.number}/head`)]);
  } catch { /* offline or a head gone: diff whatever is present; the rest falls back below */ }
  for (const row of valid) {
    try {
      const mergeBase = String(git(dir, ['merge-base', '--end-of-options', `${remote}/${base}`, row.headRefOid])).split('\n')[0].trim();
      if (!SHA.test(mergeBase)) throw new Error('no merge-base with the base branch');
      // --no-renames: a rename holds both its old and new path. -z: paths are NUL-separated, never quoted.
      const raw = String(git(dir, ['diff', '--no-ext-diff', '--no-renames', '--name-status', '-z', '--end-of-options', mergeBase, row.headRefOid]));
      const tokens = raw.split('\0').filter(Boolean);
      const files = [], added = [];
      for (let i = 0; i + 1 < tokens.length; i += 2) {
        files.push(tokens[i + 1]);
        if (tokens[i] === 'A') added.push(tokens[i + 1]);
      }
      out.set(row.number, { ok: true, files, added });
    } catch (error) { fail(row, firstLine(error)); }
  }
  return out;
}
/** GitHub's paginated files API for one PR (up to GH_API_FILE_CAP files). A rename holds both paths. */
export function readPagedFiles({ repo, number, exec }) {
  try {
    const raw = exec(['api', '--paginate', `repos/${repo}/pulls/${number}/files?per_page=100`,
      '--jq', '.[] | {s: .status, f: .filename, p: .previous_filename}']);
    const files = [], added = [];
    for (const line of String(raw).split(/\r?\n/).filter((l) => l.trim())) {
      const row = JSON.parse(line);
      if (!row || typeof row.f !== 'string') throw new Error('unexpected files API row');
      files.push(row.f);
      if (typeof row.p === 'string' && row.p) files.push(row.p);
      if (row.s === 'added') added.push(row.f);
    }
    return { ok: true, files, added };
  } catch (error) { return { ok: false, reason: firstLine(error) }; }
}
export function readOpenPrs({ repos = DEFAULT_REPOS, exec, git = gitExec(), gitDirFor = (repo) => defaultGitDirFor(repo) }) {
  const prs = [], unreadable = [];
  for (const repo of repos) {
    try {
      const rows = JSON.parse(exec(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(OPEN_PR_LIMIT), '--json', 'number,title,url,headRefOid,files']));
      const net = readNetFileSets({ dir: gitDirFor(repo), rows, git });
      const why = [];
      if (rows.length >= OPEN_PR_LIMIT) why.push(`open PR list hit the ${OPEN_PR_LIMIT}-row limit and may be truncated`);
      for (const { number, title, url, files: listedFiles = [] } of rows) {
        const listed = { ok: true, files: listedFiles.map((f) => f.path), added: listedFiles.filter((f) => f.changeType === 'ADDED').map((f) => f.path) };
        const netRead = net.get(number);
        // The paginated API costs one call per PR, so only ask it when git failed AND the cheap list is capped.
        const paged = !netRead?.ok && listed.files.length >= GH_LIST_FILE_CAP ? readPagedFiles({ repo, number, exec }) : undefined;
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
  return { prs, unreadable };
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
  env = process.env, now = Date.now, exec = ghExec(env), registryPath = defaultRegistryPath(env),
  git = gitExec(), gitDirFor = (repo) => defaultGitDirFor(repo, { root, env }) } = {}) {
  const scope = [...new Set([...files.split(','), ...(card ? readCardScope(card, { root }) : [])].map((f) => qualifyFile(f)).filter(Boolean))];
  if (!scope.length) throw new TypeError('free-scope: give --files=a,b or --card=<id>');
  return { files: scope, nowMs: now(), ...readOpenPrs({ repos, exec, git, gitDirFor }), agents: readRegistry(registryPath) };
}
