/** S1a: read-only studio observation; no leases, reaping or admission wiring. */
import * as fs from 'node:fs';
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { budgetFromSnapshot } from './resource-pool.mjs';
import { readPoolLaneStatus, poolLaneLeased } from './resource-pool-lanes.mjs';
import { admissionLockRoot, loadAdmissionPolicy, resolveSlotSpan, slotPath } from '../readiness/heavy-admission.mjs';
import { EXEMPT_DISPATCH_KINDS, PREPARE_DISPATCH_KINDS } from '../readiness/heavy-queue-projection.mjs';
import { hostname } from 'node:os';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { fixDispatchClaimRoot, fixDispatchSessionName, DEFAULT_FIX_DISPATCH_CLAIM_TTL_MINUTES } from '../conveyor/fix-claim-store.mjs';
import { parseLockEntry, isLeaseExpired, lockDirFor } from '../readiness/file-locks.mjs';
import { redTeamStatusDir } from './drain-red-team-evidence.mjs';
import { probeSlotAlive } from '../operations/red-team-slots.mjs';
import { pidStartTime, pidNamespace } from './pid-alive.mjs';
import { liveReviewRoundBudget } from '../../skills-src/conveyor/review-daemon.mjs';
// No red-team job can legitimately retain a lease beyond one day.
export const RED_TEAM_HARD_LEASE_CEILING_MS = 24 * 60 * 60 * 1000;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const clean = v => String(v).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 300);
/** Validate and read one opened object; bounded reads also refuse growth after fstat. */
export function readPoolJson(path, { io = fs } = {}) {
  const fd = io.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  try {
    const info = io.fstatSync(fd), limit = 16 * 1024 * 1024;
    if (!info.isFile() || info.size > limit) throw Error('expected regular source <=16 MiB; inspect source manually');
    const buffer = Buffer.alloc(Math.min(info.size + 1, limit + 1));
    let size = 0, n;
    while (size < buffer.length && (n = io.readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += n;
    if (size > info.size || size > limit) throw Error('source grew during read; inspect source manually');
    const text = buffer.toString('utf8', 0, size), data = JSON.parse(text);
    if (!object(data)) throw Error('expected source object; inspect source manually');
    return { data, text, mtimeMs: info.mtimeMs };
  } finally { io.closeSync(fd); }
}
const json = path => readPoolJson(path).data;
const list = path => {
  const entries = readdirSync(path, { withFileTypes: true });
  if (entries.length > 20000) throw Error('source exceeds 20000 entries; inspect/archive source manually');
  return entries;
};
/** The tolerant admission status reader can hide malformed lock.json: validate each slot directly. */
export function readPoolHeavyHeld({ env = process.env, root = admissionLockRoot(process.cwd(), env),
  cap = resolveSlotSpan(loadAdmissionPolicy({ env }).settings) } = {}) {
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > 20000) throw Error('invalid heavy capacity; inspect settings manually');
  if (!fs.lstatSync(root).isDirectory()) throw Error('invalid heavy root; inspect admission manually');
  const held = [];
  for (let i = 0; i < cap; i++) {
    const dir = lockDirFor(root, slotPath(i));
    try { if (!fs.lstatSync(dir).isDirectory()) throw Error('invalid heavy slot directory'); }
    catch (e) { if (e.code !== 'ENOENT') throw e;
      if (!fs.lstatSync(root).isDirectory()) throw Error('heavy root disappeared; inspect admission manually');
      continue; }
    const raw = json(join(dir, 'lock.json'));
    if (!parseLockEntry(JSON.stringify(raw))) throw Error('malformed heavy slot; inspect admission manually');
    held.push(raw);
  }
  return { held };
}

export const SOURCES = Object.freeze({ snapshot: 'resource-sampler snapshot (memory, swap, CPU)',
  rounds: 'liveReviewRoundBudget (bounded ps process inventory)', redTeam: 'redTeamStatusDir (canonical status files)',
  fix: 'fixDispatchClaimRoot (class-3 fix claims)', workers: 'read-only lane leases + heavy-admission held fix/ci-heal slots' });
export function poolSourcePaths({ env = process.env, coord = resolveCoordinationRoot({ env }) } = {}) {
  return { snapshot: join(coord, 'resource', 'snapshot.json'), redTeam: redTeamStatusDir(env), fix: fixDispatchClaimRoot(coord) };
}
export function poolPidAlive(pid, kill = (p, signal) => process.kill(p, signal)) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { kill(pid, 0); return true; }
  catch (e) { return e.code === 'ESRCH' ? false : e.code === 'EPERM' ? true : null; }
}
export function readPoolSource(source, { paths, coord, env = process.env, nowMs = Date.now(),
  roundBudget = liveReviewRoundBudget, run = execFileSync,
  listCommands = () => run('ps', ['-Aww', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 10000, maxBuffer: 32 * 1024 * 1024 }),
  heavyStatus = () => readPoolHeavyHeld({ env }),
  laneStatus = () => readPoolLaneStatus({ env, nowMs, run, readJson: json }),
  processAlive = poolPidAlive, readStart = pidStartTime, host = hostname(), namespace = pidNamespace(),
  slotAlive = (data, { statusAt }) => {
    const killAlive = pid => {
      const alive = processAlive(pid);
      if (typeof alive !== 'boolean') throw Error('unknown process liveness');
      return alive;
    };
    if (data.host && data.host !== host) return null;
    return probeSlotAlive(data, { killAlive, readStart, host, namespace });
  } } = {}) {
  let expiredRedTeamRows = 0;
  try {
    const holders = [];
    const add = (kind, id, priority, size, jobId) => holders.push({ kind, id, class: priority, size, source, resource: 'studio.units',
      ...(jobId ? { jobId } : {}) });
    let budget, snapshot;
    if (source === 'snapshot') {
      snapshot = json(paths.snapshot);
      budget = budgetFromSnapshot(snapshot, { nowMs });
      if (budget.unknown) throw Error('missing, stale or malformed memory/swap/CPU evidence');
    } else if (source === 'rounds') {
      const inventory = listCommands();
      const rows = String(inventory).split('\n').filter(l => l.trim());
      if (!rows.length || rows.some(l => !/^\s*\d+\s+\d+\s+\S/.test(l))
        || !rows.some(l => Number(/^\s*(\d+)/.exec(l)[1]) === process.pid))
        throw Error('incomplete ps inventory; inspect processes manually and rerun');
      const rounds = roundBudget({ env, listCommands: () => inventory });
      if (!Number.isSafeInteger(rounds?.live) || rounds.live < 0 || rounds.live > 20000) throw Error('live review rounds unknown or >20000; inspect processes manually');
      for (let i = 0; i < rounds.live; i++) add('review', `live-round-${i}`, 2, 1);
    } else if (source === 'workers') {
      const status = laneStatus();
      if (!Array.isArray(status?.lanes) || status.lanes.length > 20000) throw Error('invalid/oversized lane inventory; inspect lane-pool manually');
      const lanes = new Set();
      for (const row of status.lanes) {
        if (!object(row) || Object.hasOwn(row, 'readError') || typeof row.path !== 'string' || typeof row.leased !== 'boolean'
          || (row.lease !== null && (!object(row.lease) || typeof row.lease.session !== 'string'
            || (row.lease.purpose != null && typeof row.lease.purpose !== 'string')))
          || (row.leased && !row.lease)) throw Error('malformed lane status; inspect lane-pool manually');
        if (row.leased !== poolLaneLeased(row.lease, nowMs)) throw Error('inconsistent lane lease status; inspect lane-pool manually');
        // Both conveyor-fix and conveyor-ci-heal consume a class-3 fixer slot.
        if (!row.leased || ![row.lease.purpose, row.lease.session].some(v => /^(?:conveyor-)?(?:fix|ci-heal)(?:-|$)/.test(v ?? ''))) continue;
        if (lanes.has(row.path)) throw Error('duplicate lane status');
        lanes.add(row.path);
        add('fix', `${row.lease.session} (${row.path})`, 3, 2, row.lease.session);
      }
      const heavy = heavyStatus();
      if (!Array.isArray(heavy?.held) || heavy.held.length > 20000) throw Error('invalid heavy held inventory; inspect heavy-admission manually');
      for (const row of heavy.held) {
        if (!object(row) || !object(row.meta)) throw Error('unknown heavy holder identity; inspect heavy-admission manually');
        if (!['fix', 'ci-heal'].includes(row.meta.dispatchKind)) {
          if (['build', ...EXEMPT_DISPATCH_KINDS, ...PREPARE_DISPATCH_KINDS].includes(row.meta.dispatchKind)) continue;
          throw Error('unknown heavy holder identity; inspect heavy-admission manually');
        }
        const lane = typeof row.owner === 'string' ? row.owner.replace(/#\d+$/, '') : null;
        if (!lane) throw Error('unknown heavy holder lane; inspect heavy-admission manually');
        if (lanes.has(lane)) continue;
        lanes.add(lane);
        add('fix', row.meta.session ?? lane, 3, 2, typeof row.meta.session === 'string' ? row.meta.session : undefined);
      }
    } else if (source === 'fix') {
      for (const entry of list(paths.fix).filter(e => /^[a-f0-9]{16}$/.test(e.name))) {
        if (!entry.isDirectory()) throw Error('invalid fix lock directory');
        const raw = json(join(paths.fix, entry.name, 'lock.json'));
        // Only a readable, valid heartbeat proves expiry; mtime cannot stand in for it.
        if (typeof raw.heartbeatAt !== 'string' || !Number.isFinite(Date.parse(raw.heartbeatAt))
          || Date.parse(raw.heartbeatAt) > nowMs) throw Error(`invalid fix heartbeat: ${entry.name}`);
        if (isLeaseExpired(raw, nowMs, DEFAULT_FIX_DISPATCH_CLAIM_TTL_MINUTES)) continue;
        const row = parseLockEntry(JSON.stringify(raw));
        if (!row
          || typeof row.meta?.repo !== 'string' || !Number.isSafeInteger(row.meta.pr) || row.meta.pr <= 0
          || !['fix', 'ci-heal'].includes(row.meta.kind)) throw Error(`invalid fix claim: ${entry.name}`);
        add('fix', row.path ?? entry.name, 3, 2, fixDispatchSessionName(row.meta));
      }
    } else if (source === 'redTeam') {
      // The writer owns <encoded-repo>-<pr>-<40-hex-head>.json. Companion files are not holders.
      for (const entry of list(paths.redTeam).filter(e => /^.+-\d+-[a-f0-9]{40}\.json$/.test(e.name))) {
        const file = join(paths.redTeam, entry.name), checked = readPoolJson(file), row = checked.data;
        if (typeof row.repo !== 'string' || !Number.isSafeInteger(row.pr) || row.pr <= 0
          || typeof row.head !== 'string' || entry.name !== `${encodeURIComponent(row.repo)}-${row.pr}-${row.head}.json`
          || !['queued', 'running', 'finished', 'ok', 'failed', 'cancelled', 'canceled', 'timeout', 'timed-out', 'error'].includes(row.status)) throw Error('invalid red-team status');
        const statusAt = checked.mtimeMs;
        if (!Number.isFinite(statusAt)) throw Error('invalid red-team mtime; inspect status manually');
        if (nowMs - statusAt > RED_TEAM_HARD_LEASE_CEILING_MS) { expiredRedTeamRows++; continue; }
        if (!['running', 'queued'].includes(row.status)) continue;
        if (row.pid == null) throw Error(`unknown red-team liveness: ${entry.name}; missing pid; inspect status manually`);
        if (!Number.isSafeInteger(row.pid) || row.pid <= 0) throw Error(`invalid red-team pid: ${entry.name}`);
        if (typeof row.pidStart !== 'string' || !row.pidStart.trim()) throw Error(`invalid red-team pidStart: ${entry.name}`);
        const alive = slotAlive(row, { statusAt });
        if (typeof alive !== 'boolean') throw Error(`unknown red-team liveness: ${entry.name}; inspect host/process access`);
        if (alive) add('redTeam', `${row.repo}:${row.pr}:${row.head}`, 2, 1);
      }
    } else throw Error('unknown source');
    return { source, ok: true, holders, budget, snapshot, expiredRedTeamRows };
  } catch (e) { return { source, ok: false, holders: [], expiredRedTeamRows, error: `${clean(e.message)}; inspect source and rerun` }; }
}
