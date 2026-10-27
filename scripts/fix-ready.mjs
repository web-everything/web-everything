#!/usr/bin/env node
/** Record green, audited fixes ready for a sanctioned daemon overlay load. */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readDeclaredSettings } from './lib/settings-files.mjs';

export const FIX_READY_STORE = '~/workspace/.operations/coordination/fix-ready.jsonl';
export const validSha = (sha) => typeof sha === 'string' && /^[a-f0-9]{7,}$/i.test(sha);

export function resolveFixReadyStore(store, { env = process.env, declared = readDeclaredSettings() } = {}) {
  const configured = declared.settings?.fixNotLoaded?.storePath;
  const [path, source] = store ? [store, '--store']
    : env.FIX_READY_STORE ? [env.FIX_READY_STORE, 'FIX_READY_STORE']
      : typeof configured === 'string' && configured.trim()
        ? [configured, declared.owners['fixNotLoaded.storePath']]
        : [FIX_READY_STORE, 'built-in'];
  const expanded = path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
  return { path: resolve(expanded), source };
}

/** Invalid JSON/records are ignored; timestamp order, rather than append order, selects each ref. */
export function readFixReadyRecords(storePath) {
  let contents;
  try { contents = readFileSync(storePath, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const latest = new Map();
  for (const line of contents.split('\n')) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r || typeof r.ref !== 'string' || !r.ref.trim() || !validSha(r.sha)
      || r.tests !== 'green' || typeof r.audit !== 'string' || !r.audit.trim()
      || typeof r.at !== 'string' || !Number.isFinite(Date.parse(r.at))) continue;
    if (!latest.has(r.ref) || Date.parse(r.at) >= Date.parse(latest.get(r.ref).at)) latest.set(r.ref, r);
  }
  return [...latest.values()];
}

export function parseFlags(args) {
  return Object.fromEntries(args.map((arg) => {
    if (!arg.startsWith('--')) throw new Error(`Expected --flag: ${arg}`);
    const eq = arg.indexOf('=');
    return eq < 0 ? [arg.slice(2), true] : [arg.slice(2, eq), arg.slice(eq + 1)];
  }));
}

export function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (!['mark', 'list'].includes(command)) throw new Error('Usage: fix-ready.mjs mark --ref=... --sha=... --tests=green --audit=... | list [--json] [--store=...]');
  const flags = parseFlags(args);
  if (command === 'mark') {
    if (typeof flags.ref !== 'string' || !flags.ref.trim()) throw new Error('--ref is required');
    if (!validSha(flags.sha)) throw new Error('--sha must be hex, at least 7 characters');
    if (flags.tests !== 'green') throw new Error('--tests must be green');
    if (typeof flags.audit !== 'string' || !flags.audit.trim()) throw new Error('--audit is required');
    if (flags['load-skip-quote'] !== undefined && typeof flags['load-skip-quote'] !== 'string') throw new Error('--load-skip-quote requires a string');
    if (flags.at !== undefined && (typeof flags.at !== 'string' || !Number.isFinite(Date.parse(flags.at)))) throw new Error('--at must be an ISO timestamp');
  }
  const store = resolveFixReadyStore(flags.store);
  console.error(`fix-ready: store ${store.path} (source: ${store.source})`);
  if (command === 'list') {
    const records = readFixReadyRecords(store.path);
    console.log(flags.json ? JSON.stringify(records, null, 2) : records.map((r) => `${r.at} ${r.ref} ${r.sha} ${r.audit}`).join('\n'));
    return;
  }
  const record = { at: new Date(flags.at ?? Date.now()).toISOString(), ref: flags.ref, sha: flags.sha, tests: flags.tests, audit: flags.audit,
    ...(flags['load-skip-quote'] !== undefined ? { loadSkipQuote: flags['load-skip-quote'] } : {}), host: hostname() };
  mkdirSync(dirname(store.path), { recursive: true });
  appendFileSync(store.path, `${JSON.stringify(record)}\n`, { flag: 'a' });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error(`fix-ready: ${e.message}`); process.exitCode = 1; }
}
