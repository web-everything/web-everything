/**
 * @file scripts/operations/free-scope-io.mjs
 * @description IMPURE snapshot and registry boundary for free-scope. GitHub, YAML, clock and filesystem
 * reads live here; atomic locked updates keep concurrent workers from overwriting one another's scopes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { runGhSync } from '../lib/gh-throttle.mjs';
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
  const temp = `${file}.tmp-${process.pid}`;
  try { fs.writeFileSync(temp, `${JSON.stringify({ entries }, null, 2)}\n`); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}
export function updateRegistry(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`, deadline = Date.now() + 5000;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  let identity;
  for (;;) {
    try { fs.mkdirSync(lock); identity = fs.statSync(lock); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 30000) { fs.rmdirSync(lock); continue; } }
      catch (race) { if (race.code !== 'ENOENT') throw race; }
      if (Date.now() >= deadline) throw new Error(`free-scope: timed out acquiring ${lock}`);
      Atomics.wait(sleeper, 0, 0, 25);
    }
  }
  try { const entries = fn(readRegistry(file)); writeRegistry(file, entries); return entries; }
  finally {
    try { if (fs.statSync(lock).ino === identity.ino) fs.rmdirSync(lock); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
export function ghExec(env = process.env) {
  return (args) => env.WE_FREE_SCOPE_GH_BIN
    ? execFileSync(env.WE_FREE_SCOPE_GH_BIN, args, { encoding: 'utf8' })
    : runGhSync(args, { encoding: 'utf8' });
}
export function readOpenPrs({ repos = DEFAULT_REPOS, exec }) {
  const prs = [], unreadable = [];
  for (const repo of repos) {
    try {
      const rows = JSON.parse(exec(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '200', '--json', 'number,title,url,files']));
      prs.push(...rows.map(({ number, title, url, files }) => ({ repo, number, title, url, files: files.map((f) => f.path) })));
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
export function readCardScope(card, { root }) {
  const file = findCardFile(card, { root });
  if (!file) throw new Error(`free-scope: card ${card} not found`);
  const scope = matter(fs.readFileSync(file, 'utf8')).data.scope;
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
