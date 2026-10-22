import { execFileSync } from 'node:child_process';
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readDeclaredSettings } from './lib/settings-files.mjs';
import { parseDigest, resolveDigestPath } from './lib/rulings-digest.mjs';
import { defaultPoolRoot } from './lib/lane-pool-paths.mjs';
import { LEASE_FILENAME, isLeaseStale } from './lib/lane-lease.mjs';

const sections = ['pendingAsks', 'agents', 'leases', 'readyNotLoaded', 'memOwed'];
const bytes = (value) => Buffer.byteLength(value, 'utf8');
const expand = (path) => path.replace(/^~(?=\/|$)/, homedir());
const positive = (value, fallback) => Number.isInteger(value) && value > 0 ? value : fallback;
const oneLine = (value) => String(value ?? '').replace(/[\r\n]+/g, ' ');

export function resolveSnapshotConfig({ settings = readDeclaredSettings(), env = process.env } = {}) {
  const config = settings.settings?.precompactSnapshot ?? {};
  return {
    snapshotPath: expand(env.PRECOMPACT_SNAPSHOT_PATH || config.snapshotPath || '~/workspace/.operations/handoff/session-snapshot.json'),
    handoffPath: expand(env.PRECOMPACT_HANDOFF_PATH || config.handoffPath || '~/workspace/.operations/handoff/handoff-webeverything.md'),
    storePath: expand(env.FIX_READY_STORE || settings.settings?.fixNotLoaded?.storePath || '~/workspace/.operations/coordination/fix-ready.jsonl'),
    selfSyncDir: expand(env.HEALTH_WATCH_SELF_SYNC_DIR || '~/.claude/daemon-self-sync-state'),
    maxBytes: positive(config.maxBytes, 4096), keep: positive(config.keep, 3),
  };
}

/** Pure assembly and byte cap. Ties favor dropping the earlier section in `sections`. */
export function buildSnapshot(inputs = {}, { maxBytes = 4096 } = {}) {
  const at = inputs.at ?? new Date(0).toISOString();
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const part = (name) => parts.find((p) => p.type === name).value;
  const snapshot = { at, atEt: `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`,
    sessionId: String(inputs.sessionId ?? ''), trigger: inputs.trigger === 'manual' ? 'manual' : 'auto',
    ...Object.fromEntries(sections.map((key) => [key, Array.isArray(inputs[key]) ? [...inputs[key]] : []])),
    ...(inputs.errors?.length ? { errors: [...inputs.errors] } : {}),
  };
  while (bytes(JSON.stringify(snapshot)) > maxBytes) {
    snapshot.truncated = true;
    const key = sections.filter((key) => snapshot[key].length)
      .sort((a, b) => bytes(JSON.stringify(snapshot[b])) - bytes(JSON.stringify(snapshot[a])))[0];
    if (key) {
      if (key === 'pendingAsks') snapshot[key].shift();
      else snapshot[key].pop();
    } else if (snapshot.errors?.length) snapshot.errors.pop();
    else if (snapshot.sessionId.length) snapshot.sessionId = snapshot.sessionId.slice(0, -1);
    else break; // Required metadata alone cannot fit an arbitrarily small cap.
  }
  return snapshot;
}

export function pushSnapshot(existingJson, snapshot, keep = 3) {
  let existing;
  try { existing = typeof existingJson === 'string' ? JSON.parse(existingJson) : existingJson; } catch { /* start fresh */ }
  return { snapshots: [...(Array.isArray(existing?.snapshots) ? existing.snapshots : []), snapshot].slice(-positive(keep, 3)) };
}

/** Cap text without splitting a line or UTF-8 character. */
export function capSnapshotText(text, maxBytes) {
  if (bytes(text) <= maxBytes) return text;
  const marker = '… snapshot truncated';
  if (bytes(marker) > maxBytes) return '';
  const kept = [];
  for (const line of text.split('\n')) {
    if (bytes([...kept, line, marker].join('\n')) > maxBytes) break;
    kept.push(line);
  }
  return [...kept, marker].join('\n');
}

export function renderSnapshot(snapshot, { maxBytes = 4096 } = {}) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return '';
  const lines = [`Pre-compaction snapshot (${oneLine(snapshot.atEt)} ET, trigger ${oneLine(snapshot.trigger)}):`];
  const add = (key, label, render) => {
    if (Array.isArray(snapshot[key]) && snapshot[key].length) lines.push(`- ${label}: ${snapshot[key].map(render).join(', ')}`);
  };
  add('agents', 'agents', (a) => `${oneLine(a.name)}(${oneLine(a.status)})`);
  add('leases', 'leases', (l) => `${oneLine(l.lane)} ${oneLine(l.purpose || l.holder)}`);
  add('readyNotLoaded', 'ready not loaded', (r) => `${oneLine(r.ref)}@${oneLine(r.sha)}`);
  add('memOwed', 'mem owed', (r) => oneLine(r.id ?? r));
  if (Array.isArray(snapshot.pendingAsks) && snapshot.pendingAsks.length) {
    lines.push('- pending asks:', ...snapshot.pendingAsks.map((ask) => `  - ${oneLine(ask)}`));
  }
  if (Array.isArray(snapshot.errors)) {
    for (const error of snapshot.errors) {
      const [source, ...detail] = oneLine(error).split(':');
      lines.push(`- unavailable: ${source.trim()} (${detail.join(':').trim() || 'failed'})`);
    }
  }
  if (lines.length === 1) lines.push('(none)');
  if (snapshot.truncated) lines.push('… snapshot truncated');
  return capSnapshotText(lines.join('\n'), maxBytes);
}

function readLeases(poolRoot) {
  const leases = [];
  for (const repo of readdirSync(poolRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    for (const lane of readdirSync(join(poolRoot, repo.name)).filter((name) => /^lane-\d+$/.test(name))) {
      let lease;
      // A lane's lease lives in its git dir (`<lane>/.git/.lane-lease`), where lane-pool writes it.
      try { lease = JSON.parse(readFileSync(join(poolRoot, repo.name, lane, '.git', LEASE_FILENAME), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue; throw error; }
      if (isLeaseStale(lease, Date.now())) continue;
      leases.push({ lane: `${repo.name}/${lane}`, holder: lease.holder || lease.session || '',
        purpose: lease.purpose || '', since: lease.acquiredAt || '' });
    }
  }
  return leases;
}

function readReady(config) {
  const latest = new Map();
  for (const line of readFileSync(config.storePath, 'utf8').split(/\r?\n/).filter((line) => line.trim())) {
    const record = JSON.parse(line);
    if (record.ref) latest.set(record.ref, record);
  }
  let names;
  try { names = readdirSync(config.selfSyncDir); }
  catch (error) { if (error.code !== 'ENOENT') throw error; names = []; }
  const applied = names.filter((name) => name.endsWith('.rebuild.json')).flatMap((name) => {
    const state = JSON.parse(readFileSync(join(config.selfSyncDir, name), 'utf8'));
    return (state.adopted?.applied ?? []).map((entry) => typeof entry === 'string' ? entry : entry.sha);
  });
  const matches = (a, b) => typeof a === 'string' && typeof b === 'string'
    && /^[a-f\d]{7,}$/i.test(a) && /^[a-f\d]{7,}$/i.test(b)
    && (a.toLowerCase().startsWith(b.toLowerCase()) || b.toLowerCase().startsWith(a.toLowerCase()));
  return [...latest.values()].filter((r) => !r.loadSkipQuote && typeof r.sha === 'string'
    && !applied.some((sha) => matches(r.sha, sha)))
    .map((r) => ({ ref: r.ref, sha: r.sha.slice(0, 10), at: r.at }));
}

export function writeSnapshotAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temp, path);
  } finally {
    try { unlinkSync(temp); } catch { /* renamed, or creation failed */ }
  }
}

function warn(message) {
  try { process.stderr.write(`precompact snapshot: ${oneLine(message)}\n`); } catch { /* closed pipe */ }
}

// The rulings writer embeds its lock and preserves live owners past the stale age;
// this hook instead needs bounded waiting and unconditional stale-lock recovery.
async function takeSnapshotLock(path) {
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + 2000;
  while (true) {
    let fd;
    try { fd = openSync(lockPath, 'wx', 0o600); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const info = statSync(lockPath);
        if (Date.now() - info.mtimeMs > 30000 && statSync(lockPath).ino === info.ino) unlinkSync(lockPath);
      } catch (probe) { if (probe.code !== 'ENOENT') throw probe; }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${lockPath}`);
      await delay(25);
      continue;
    }
    const info = fstatSync(fd);
    return () => {
      try {
        // A stale owner must not remove a successor's lock.
        if (statSync(lockPath).ino === info.ino) unlinkSync(lockPath);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      finally { closeSync(fd); }
    };
  }
}

async function main() {
  process.exitCode = 0;
  process.stderr.on('error', () => {});
  try {
    let hook = {};
    try { hook = JSON.parse(readFileSync(0, 'utf8')) ?? {}; } catch { warn('invalid hook input'); }
    const settings = readDeclaredSettings();
    const config = resolveSnapshotConfig({ settings });
    const errors = [];
    const capture = (name, read) => {
      try { return read(); } catch (error) {
        const message = `${name}: ${error.code || error.name || 'failed'}`;
        errors.push(message); warn(message); return [];
      }
    };
    const agents = capture('agents', () => {
      const result = JSON.parse(execFileSync('claude', ['agents', '--json'], {
        encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'],
      }));
      // The captured CLI payload includes waiting background agents and interactive
      // agents without status. Unknown/missing statuses must not hide in-flight work.
      const inactive = new Set(['idle', 'completed', 'done', 'exited', 'stopped', 'failed']);
      return (Array.isArray(result) ? result : result.agents)
        .filter((a) => !inactive.has(a.status))
        .map((a) => ({ name: a.name, status: a.status ?? a.state ?? 'unknown', kind: a.kind,
          sessionId: String(a.sessionId ?? a.session_id ?? '').slice(0, 8) }));
    });
    const leases = capture('leases', () => readLeases(defaultPoolRoot(dirname(dirname(fileURLToPath(import.meta.url))))));
    const readyNotLoaded = capture('readyNotLoaded', () => readReady(config));
    const memOwed = capture('memOwed', () => parseDigest(readFileSync(resolveDigestPath({ settings }).path, 'utf8'))
      .filter((r) => r.active && r.tags.mem === 'owed').map(({ id, rule }) => ({ id, rule })));
    const pendingAsks = capture('pendingAsks', () => readFileSync(config.handoffPath, 'utf8').split(/\r?\n/)
      .filter((line) => line.includes('- [ ]') || line.includes('Needs your call')).slice(-20).map((line) => line.trim().slice(0, 200)));
    const snapshot = buildSnapshot({ at: new Date().toISOString(), sessionId: hook.session_id, trigger: hook.trigger,
      agents, leases, readyNotLoaded, memOwed, pendingAsks, errors }, config);
    let release;
    try { release = await takeSnapshotLock(config.snapshotPath); }
    catch (error) { warn(`history lock unavailable (${error.code || error.message}); writing without lock`); }
    try {
      let existing;
      try { existing = readFileSync(config.snapshotPath, 'utf8'); } catch { /* first snapshot */ }
      writeSnapshotAtomic(config.snapshotPath, pushSnapshot(existing, snapshot, config.keep));
    } finally { release?.(); }
  } catch (error) { warn(error.code || error.message || 'failed'); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
