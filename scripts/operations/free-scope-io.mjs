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
import { DEFAULT_REPOS, qualifyFile } from './free-scope.mjs';
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
export const PR_FILES_LIMIT = 100;
export function readOpenPrs({ repos = DEFAULT_REPOS, exec }) {
  const prs = [], unreadable = [];
  for (const repo of repos) {
    try {
      const rows = JSON.parse(exec(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(OPEN_PR_LIMIT), '--json', 'number,title,url,files']));
      prs.push(...rows.map(({ number, title, url, files }) => ({ repo, number, title, url, files: files.map((f) => f.path) })));
      // The rows read still count as holders, but the snapshot is incomplete: never let it answer "free".
      const why = [];
      if (rows.length >= OPEN_PR_LIMIT) why.push(`open PR list hit the ${OPEN_PR_LIMIT}-row limit and may be truncated`);
      const capped = rows.filter(({ files }) => files.length >= PR_FILES_LIMIT).map(({ number }) => `#${number}`);
      if (capped.length) why.push(`PR ${capped.join(', ')} list${capped.length === 1 ? 's' : ''} ${PR_FILES_LIMIT} files (the gh cap) and may touch more`);
      if (why.length) unreadable.push({ repo, error: why.join('; ') });
    } catch (error) { unreadable.push({ repo, error: error.message.split(/\r?\n/)[0] }); }
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
  env = process.env, now = Date.now, exec = ghExec(env), registryPath = defaultRegistryPath(env) } = {}) {
  const scope = [...new Set([...files.split(','), ...(card ? readCardScope(card, { root }) : [])].map((f) => qualifyFile(f)).filter(Boolean))];
  if (!scope.length) throw new TypeError('free-scope: give --files=a,b or --card=<id>');
  return { files: scope, nowMs: now(), ...readOpenPrs({ repos, exec }), agents: readRegistry(registryPath) };
}
