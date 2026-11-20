#!/usr/bin/env node
/** Observe-only stuck-PR snapshot. The only writes are NEW-cause event receipts/events. */
import { openSync, fstatSync, readSync, closeSync, readFileSync, writeFileSync, mkdirSync, rmdirSync, renameSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluateStuck } from './pass-daemons/stuck-rules.mjs';
import { fixDispatchClaimRoot, fixDispatchSessionName } from './fix-claim-store.mjs';
import { parseLockEntry } from '../readiness/file-locks.mjs';
import { isClaimSessionLive } from './fix-dispatch-claim.mjs';
import { runGhSync } from '../lib/gh-throttle.mjs';
import { handoffHome } from '../lib/handoff-path.mjs';
import { appendDaemonEvent } from '../lib/daemon-events.mjs';

const warnDefault = s => console.error(`stuck-prs: ${s}`);
const safeText = s => String(s).replace(/[\x00-\x1f\x7f-\x9f]/g, '');
export function readLogTail(path, { maxBytes = 8 * 1024 * 1024, warn = warnDefault } = {}) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size, start = Math.max(0, size - maxBytes), bytes = Buffer.alloc(Math.min(size, maxBytes));
    const count = readSync(fd, bytes, 0, bytes.length, start);
    let text = bytes.subarray(0, count).toString('utf8');
    if (start) { text = text.slice(text.indexOf('\n') + 1); warn('log tail capped at 8 MB; earlier history unknown; inspect daemon logs for omitted PRs'); }
    const end = text.lastIndexOf('\n');
    if (end < 0) return [];
    // Untimestamped lines are multi-line continuations (stack/JSON bodies), never decision records.
    return text.slice(0, end).split('\n').map(line => ({
      at: /\d{4}-\d\d-\d\dT[\d:.]+Z/.exec(line)?.[0] ?? null, line,
    })).filter(r => r.at);
  } catch { warn('log unreadable; evidence unknown; inspect daemon logs'); return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function collectClaims(warn = warnDefault, { claimRoot = fixDispatchClaimRoot(), now = Date.now,
  // Unlike the tolerant dispatch listing, a snapshot must expose unreadable claim evidence.
  listClaims = () => readdirSync(claimRoot).map(name => {
    const file = join(claimRoot, name, 'lock.json'), entry = parseLockEntry(readFileSync(file, 'utf8'));
    if (!entry) throw Error('invalid claim');
    let mtimeMs;
    try { mtimeMs = statSync(file).mtimeMs; } catch { /* fall back to metadata */ }
    return { ...entry, mtimeMs };
  }), readAgents = () => JSON.parse(execFileSync('claude', ['agents', '--json', '--all'],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 })),
} = {}) {
  const claims = listClaims().filter(c => ['web-everything', 'web-everything/web-everything'].includes(c.meta?.repo)
    && ['fix', 'ci-heal'].includes(c.meta.kind));
  let agents = null;
  if (claims.length) try {
    const result = readAgents();
    if (!Array.isArray(result.agents ?? result)) throw Error('invalid sessions');
    agents = result.agents ?? result;
  } catch { warn('claim sessions unreadable; liveness unknown; inspect claude agents'); }
  return claims.map(c => {
    const holder = c.meta.who ?? fixDispatchSessionName({ repo: 'web-everything', pr: c.meta.pr, kind: c.meta.kind });
    const live = agents !== null && isClaimSessionLive({ repo: 'web-everything', pr: c.meta.pr, kind: c.meta.kind, name: holder, agentsAll: agents });
    const timestamp = Number.isFinite(c.mtimeMs) ? c.mtimeMs : Date.parse(c.meta.claimedAt ?? c.heartbeatAt);
    return { pr: c.meta.pr, kind: c.meta.kind, holder, live: live ? true
      : agents !== null && Number.isFinite(timestamp) && now() - timestamp > 10 * 60000 ? false : null };
  });
}

/** Reserve before sending: concurrent invocations/restarts never repeat a PR/rule/head event.
 * A crash after reservation can lose the event; an unreadable/oversized ledger or abandoned
 * lock requires operator inspection. A failed append releases its reservation for retry.
 */
export async function emitNewCauses(records, prs, { statePath = join(handoffHome(), 'stuck-prs.json'),
  send = appendDaemonEvent, warn = warnDefault } = {}) {
  const fresh = records.filter(r => r.cause === 'NEW');
  if (!fresh.length) return;
  let locked = false;
  try {
    mkdirSync(`${statePath}.lock`); locked = true;
    let ledger = [];
    try {
      const fd = openSync(statePath, 'r');
      try { if (fstatSync(fd).size > 256 * 1024) throw Error('oversized receipts'); ledger = JSON.parse(readFileSync(fd, 'utf8')); }
      finally { closeSync(fd); }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!Array.isArray(ledger) || !ledger.every(k => typeof k === 'string')) throw Error('invalid receipts');
    const heads = new Map(prs.map(p => [p.number, p.headSha ?? p.headRefOid]));
    const keys = new Set(ledger);
    const save = () => {
      writeFileSync(`${statePath}.next`, JSON.stringify([...keys]), { mode: 0o600 });
      renameSync(`${statePath}.next`, statePath);
    };
    for (const record of fresh) {
      const head = heads.get(record.pr);
      if (!/^[a-f0-9]{40}$/.test(head ?? '')) continue;
      const key = JSON.stringify([record.pr, record.rule, head]);
      if (keys.has(key)) continue;
      if (keys.size >= 1000) throw Error('receipt limit reached');
      keys.add(key);
      save();
      try {
        if (await send({ kind: 'stuck-pr', daemon: 'stuck-pr-detector', pr: record.pr,
          detail: { ...record, head, needsYou: true } }) === false) throw Error('append failed');
      } catch {
        keys.delete(key); save();
        warn('event append failed; reservation restored for retry');
      }
    }
  } catch { warn('NEW-cause receipts unavailable/capped/locked; no event sent; inspect stuck-prs.json and its lock'); }
  finally { if (locked) rmdirSync(`${statePath}.lock`); }
}

export async function runStuckCli(args = [], { now = () => new Date().toISOString(), warn: reportWarning = warnDefault,
  readPrs = argv => JSON.parse(runGhSync(argv, { encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 })),
  readLogs, readClaims, emit = emitNewCauses } = {}) {
  const warnings = [], unknown = [];
  const warn = message => { warnings.push(message); reportWarning(message); };
  readLogs ??= () => {
    const workspace = join(homedir(), 'workspace');
    return Object.fromEntries(Object.entries({ fix: 'wev-fix-daemon/.conveyor/fix-dispatch-daemon.log',
      review: 'wev-review-daemon/.conveyor/review-daemon.log', drain: 'plateau-app/.drain-daemon/daemon.log' })
      .map(([name, path]) => [name, readLogTail(join(workspace, path), { warn })]));
  };
  readClaims ??= () => collectClaims(warn, { now: () => Date.parse(now()) });
  let prs;
  try {
    prs = await readPrs(['pr', 'list', '--repo', 'web-everything/web-everything', '--state', 'open', '--json',
      'number,headRefOid,labels,mergeStateStatus', '--limit', '200']);
    if (!Array.isArray(prs)) throw Error('invalid PR list');
    if (prs.length >= 200) warn('200 PR listing cap reached; omitted PRs unknown; inspect open PRs manually');
  } catch {
    warn('PR list unreadable; evidence unknown; inspect open PRs manually');
    process.exitCode = 1;
    return args.includes('--json') ? JSON.stringify({ unknown: true, records: [], warnings }) : 'unknown';
  }
  const normalized = prs.map(p => ({ ...p, headSha: p.headSha ?? p.headRefOid,
    labels: Array.isArray(p.labels) ? p.labels.map(l => typeof l === 'string' ? l : l?.name) : null }));
  let logs = {}, claims = null;
  try { logs = await readLogs(); } catch { warn('daemon logs unreadable; evidence unknown'); }
  try { claims = await readClaims(); } catch { warn('claims unreadable; evidence unknown'); }
  for (const name of ['fix', 'review', 'drain']) if (!Array.isArray(logs?.[name])) {
    unknown.push(name); warn(`${name} log missing/unreadable; evidence unknown; inspect daemon logs`);
  }
  if (!Array.isArray(claims)) { unknown.push('claims'); warn('claims missing/unreadable; evidence unknown; inspect claims'); }
  const records = evaluateStuck({ now: now(), prs: normalized, logs, claims });
  await emit(records, normalized);
  if (args.includes('--json') && (unknown.length || warnings.length)) return JSON.stringify({ records, unknown, warnings });
  if (!records.length) return unknown.length ? 'unknown' : 'none';
  return args.includes('--json') ? JSON.stringify(records) : records.map(r =>
    safeText(`#${r.pr} ${r.rule} (cause ${r.cause}) since ${r.sinceET} ET ${r.link}`)).join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  runStuckCli(process.argv.slice(2)).then(output => console.log(output)).catch(() => { console.error('stuck-prs: snapshot unavailable; inspect evidence manually'); process.exitCode = 1; });
