#!/usr/bin/env node
/**
 * @file Session-start check: does this session load the canonical orchestrator knowledge store?
 *
 * Claude Code loads auto-memory from ~/.claude/projects/<project-key>/memory, where the key is the
 * session's start directory with every non-alphanumeric character turned into "-". Starting the
 * orchestrator in a different directory therefore loads a different (often tiny) store. This check
 * lists every store with its entry count, says which one THIS session would load, and exits 1 when
 * that is not the canonical store, or when the loaded store is small while a larger one exists.
 *
 * Read-only: it never writes. Merging a small store into the canonical one is the separate,
 * proposal-first `knowledge-store-sync.mjs`.
 *
 * Feeds card 0k (the private, versioned knowledge repo): once the canonical store lives in a
 * versioned repo and is linked into the project-key location, this same check proves every host and
 * start directory resolves (directly or via the link) to that one store.
 *
 * usage: node scripts/operations/knowledge-store-check.mjs [--cwd=DIR] [--home=DIR]
 *          [--canonical-dir=DIR] [--min-entries=N] [--json]
 *   --canonical-dir  directory the canonical store is keyed on (default: <home>/workspace/webeverything,
 *                    or env KNOWLEDGE_STORE_CANONICAL_DIR)
 */
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_MIN_ENTRIES = 50;

/** Claude Code's project key for a start directory. */
export function projectKey(dir) {
  return String(dir).replace(/[^a-zA-Z0-9]/g, '-');
}

/** Entry files of a memory dir: every *.md except the MEMORY.md index. */
export function listEntries(memoryDir) {
  if (!existsSync(memoryDir)) return [];
  return readdirSync(memoryDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').sort();
}

function real(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Every projects/<key>/memory store under the home dir, with its entry count. */
export function scanStores(home) {
  const root = join(home, '.claude', 'projects');
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((key) => ({ key, dir: join(root, key, 'memory') }))
    .filter((s) => existsSync(s.dir))
    .map((s) => ({ ...s, real: real(s.dir), count: listEntries(s.dir).length }))
    .sort((a, b) => b.count - a.count);
}

function missingStore(root, key) {
  const dir = join(root, key, 'memory');
  return { key, dir, real: dir, count: 0, missing: true };
}

/** Pure verdict from scan results; no filesystem access. */
export function evaluate({ stores, cwd, home, canonicalDir, minEntries = DEFAULT_MIN_ENTRIES }) {
  const root = join(home, '.claude', 'projects');
  const loadedKey = projectKey(cwd);
  const canonicalKey = projectKey(canonicalDir);
  const loaded = stores.find((s) => s.key === loadedKey) || missingStore(root, loadedKey);
  const canonical = stores.find((s) => s.key === canonicalKey) || missingStore(root, canonicalKey);
  const isCanonical = loaded.key === canonical.key || loaded.real === canonical.real;
  const larger = stores.filter((s) => s.real !== loaded.real && s.count > loaded.count).sort((a, b) => b.count - a.count)[0];
  const problems = [];
  if (canonical.missing) problems.push(`canonical store "${canonical.key}" does not exist`);
  if (!isCanonical) problems.push(`session loads store "${loaded.key}" (${loaded.count} entries), not the canonical "${canonical.key}" (${canonical.count} entries)`);
  if (loaded.count < minEntries && larger) problems.push(`loaded store has ${loaded.count} entries (< ${minEntries}) while "${larger.key}" has ${larger.count}`);
  const fixes = [];
  if (problems.length) {
    fixes.push(`start in ${canonicalDir}`);
    fixes.push(`link ${canonical.dir} as ${loaded.dir} (move or merge ${loaded.dir} first; see knowledge-store-sync.mjs)`);
  }
  return { ok: problems.length === 0, loaded, canonical, isCanonical, stores, problems, fixes };
}

/** Plain-text report. */
export function formatReport(result) {
  const lines = ['knowledge stores (entries, key):'];
  const empty = result.stores.filter((s) => s.count === 0 && s.real !== result.loaded.real).length;
  for (const s of result.stores) {
    if (s.count === 0 && s.real !== result.loaded.real) continue;
    const tags = [s.real === result.loaded.real ? 'LOADED' : '', s.key === result.canonical.key ? 'CANONICAL' : ''].filter(Boolean).join(',');
    lines.push(`  ${String(s.count).padStart(4)}  ${s.key}${tags ? `  [${tags}]` : ''}`);
  }
  if (empty) lines.push(`  (${empty} empty stores not shown)`);
  if (result.loaded.missing) lines.push(`  (loaded store ${result.loaded.key} does not exist: 0 entries)`);
  lines.push(`loaded: ${result.loaded.key} (${result.loaded.count} entries)`);
  lines.push(`canonical: ${result.canonical.key} (${result.canonical.count} entries); loaded is canonical: ${result.isCanonical ? 'yes' : 'NO'}`);
  if (result.ok) lines.push('OK');
  else {
    for (const p of result.problems) lines.push(`PROBLEM: ${p}`);
    lines.push('FIX (either):');
    for (const f of result.fixes) lines.push(`  - ${f}`);
  }
  return lines.join('\n');
}

export function parseArgs(argv, env = process.env) {
  const opts = { cwd: process.cwd(), home: homedir(), canonicalDir: env.KNOWLEDGE_STORE_CANONICAL_DIR || '', minEntries: DEFAULT_MIN_ENTRIES, json: false };
  for (const arg of argv) {
    const m = /^--([^=]+)(?:=([\s\S]*))?$/.exec(arg);
    if (!m) throw new Error(`unexpected argument: ${arg}`);
    const [, flag, val] = m;
    if (flag === 'json') opts.json = true;
    else if (flag === 'cwd' && val) opts.cwd = val;
    else if (flag === 'home' && val) opts.home = val;
    else if (flag === 'canonical-dir' && val) opts.canonicalDir = val;
    else if (flag === 'min-entries' && /^\d+$/.test(val || '')) opts.minEntries = Number(val);
    else throw new Error(`bad flag: ${arg}`);
  }
  if (!opts.canonicalDir) opts.canonicalDir = join(opts.home, 'workspace', 'webeverything');
  return opts;
}

export function main(argv = process.argv.slice(2), out = (s) => process.stdout.write(`${s}\n`)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    out(err.message);
    return 2;
  }
  const result = evaluate({ stores: scanStores(opts.home), cwd: opts.cwd, home: opts.home, canonicalDir: opts.canonicalDir, minEntries: opts.minEntries });
  out(opts.json ? JSON.stringify(result, null, 2) : formatReport(result));
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
