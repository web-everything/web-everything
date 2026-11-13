/** Read-only occupied-slot inventory; only --emit writes events and deduplication state. */
import { readFileSync, statSync, opendirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { redTeamStatusDir } from '../lib/drain-red-team-evidence.mjs';
import { defaultQueueFile } from '../lib/red-team-dispatch-queue.mjs';
import { RED_TEAM_SETTINGS_FILE } from '../lib/red-team-gate.mjs';
import { resolveCascade, platformPreference, formatCascadeSourcesLine } from '../lib/policy-cascade.mjs';
import { pidAlive, pidStartTime, pidNamespace } from '../lib/pid-alive.mjs';
import { appendDaemonEvent } from '../lib/daemon-events.mjs';

export const DEFAULT_STUCK_AFTER_MS = 20 * 60 * 1000;
export const MAX_AGE_MS = 48 * 60 * 60 * 1000;
const clean = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
const validMs = value => Number.isSafeInteger(value) && value > 0;
const stamp = value => typeof value === 'number' ? value : Date.parse(value);

export function resolveSlotThreshold({ file = {}, platform = {}, env = {} } = {}) {
  const pick = block => block?.slotStuckAfterMs === undefined ? {} : {
    slotStuckAfterMs: validMs(block.slotStuckAfterMs) ? block.slotStuckAfterMs : DEFAULT_STUCK_AFTER_MS,
  };
  const raw = env.WE_RED_TEAM_SLOT_STUCK_AFTER_MS;
  const parsed = typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
  return resolveCascade({ standard: { slotStuckAfterMs: DEFAULT_STUCK_AFTER_MS },
    platform: pick(platform), tool: pick(file.redTeam),
    envValues: { slotStuckAfterMs: raw === undefined ? undefined : validMs(parsed) ? parsed : DEFAULT_STUCK_AFTER_MS },
    valid: validMs });
}

export function parseSlotPsRows(output) {
  return String(output).split('\n').filter(line => line.trim()).map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!match) throw new Error('Incomplete process snapshot; inspect ps output manually');
    return { pid: Number(match[1]), ppid: Number(match[2]), etime: match[3], command: clean(match[4]).slice(0, 160) };
  });
}

export function slotChildren(pid, psRows) {
  const children = [];
  const seen = new Set([pid]);
  let parents = [pid];
  for (let depth = 0; depth < 6 && parents.length && children.length < 20; depth++) {
    const next = [];
    for (const row of psRows) {
      if (!parents.includes(row.ppid) || seen.has(row.pid)) continue;
      seen.add(row.pid);
      next.push(row.pid);
      children.push({ pid: row.pid, etime: row.etime, command: clean(row.command).slice(0, 160) });
      if (children.length === 20) break;
    }
    parents = next;
  }
  return children;
}

/** statuses are { data, mtimeMs, birthtimeMs }; aliveFn returns true, false, or null (unknown). */
export function buildSlotReport({ statuses, psRows = [], queueRows = [], now,
  stuckAfterMs = DEFAULT_STUCK_AFTER_MS, aliveFn }) {
  const slots = [];
  let ancientOrphans = 0;
  for (const { data, mtimeMs, birthtimeMs } of statuses) {
    if (!Number.isFinite(mtimeMs)) throw new Error('Missing status mtime; inspect status files manually');
    if (now - mtimeMs > MAX_AGE_MS) { ancientOrphans++; continue; }
    if (!data || typeof data !== 'object' || typeof data.status !== 'string') throw new Error('Invalid status evidence');
    if (!['queued', 'running'].includes(data.status)) continue;
    if (!data.repo || !Number.isSafeInteger(Number(data.pr)) || Number(data.pr) <= 0 || !data.head) {
      throw new Error('Incomplete occupied-slot identity; inspect status files manually');
    }
    const alive = aliveFn(data);
    const admitted = [data.admittedAt, data.startedAt, data.queuedAt, data.queued, birthtimeMs]
      .map(stamp).find(Number.isFinite);
    if (admitted === undefined) throw new Error('Missing slot admission timestamp');
    const idleMs = Math.max(0, now - mtimeMs);
    const reason = alive === false ? 'pid-dead' : idleMs > stuckAfterMs ? 'no-progress' : null;
    const seat = data.result?.provider ?? data.result?.seat?.provider
      ?? data.loopPayload?.provider ?? data.loopPayload?.seat?.provider ?? null;
    slots.push({ repo: data.repo, pr: data.pr, head: data.head, status: data.status,
      kind: 'red-team', seat, pid: data.pid ?? null, pidAlive: alive,
      admittedAt: new Date(admitted).toISOString(), lastProgressAt: new Date(mtimeMs).toISOString(),
      idleMs, reason, children: alive === true ? slotChildren(data.pid, psRows) : [] });
  }
  const queuedNotRunning = queueRows.filter(row => !slots.some(slot => slot.repo === row.repo
    && Number(slot.pr) === Number(row.pr) && slot.head === row.head))
    .map(({ key, repo, pr, head, attempts }) => ({ key, repo, pr, head, attempts }));
  return { slots, stuck: slots.filter(slot => slot.reason), queuedNotRunning, ancientOrphans, stuckAfterMs };
}

export function probeSlotAlive(status, { killAlive, readStart, host, namespace }) {
  if ((status.host && status.host !== host) || (status.pidNamespace && status.pidNamespace !== namespace)) return null;
  if (!killAlive(status.pid)) return false;
  if (!status.pidStart) return true;
  const start = readStart(status.pid);
  if (!start) return null;
  const normalize = value => String(value).trim().replace(/\s+/g, ' ');
  return normalize(start) === normalize(status.pidStart);
}

/** Only recent JSON files are read. Overflow is an error, never an apparently complete inventory. */
export function readSlotStatuses(dir, { openDir = opendirSync, stat = statSync, readFile = readFileSync, now } = {}) {
  let handle;
  try { handle = openDir(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const statuses = [];
  try {
    let entry;
    let scanned = 0;
    while ((entry = handle.readSync())) {
      if (++scanned > 20000) throw new Error('Status scan exceeds 20000 entries; inspect/archive the status directory manually');
      if (!entry.name.endsWith('.json')) continue;
      const path = join(dir, entry.name);
      const info = stat(path);
      if (!info.isFile()) continue;
      const ancient = now - info.mtimeMs > MAX_AGE_MS;
      if (!ancient && info.size > 16 * 1024 * 1024) continue; // oversized recent file: skip, never abort the whole report
      let data = null;
      if (!ancient) { try { data = JSON.parse(readFile(path, 'utf8')); } catch { continue; } }
      statuses.push({ mtimeMs: info.mtimeMs, birthtimeMs: info.birthtimeMs, data });
    }
  } finally { handle.closeSync(); }
  return statuses;
}

export async function emitStuckSlots(stuck, { state = {}, appendEvent, saveState, now }) {
  const entries = new Map(Object.entries(state));
  for (const slot of stuck) {
    const key = `${slot.repo}#${slot.pr}@${slot.head}:${slot.pid}`;
    if (entries.has(key)) continue;
    const ok = await appendEvent({ kind: 'red-team-slot-stuck', repo: slot.repo, pr: slot.pr,
      daemon: 'red-team-slots', detail: { head: slot.head, pid: slot.pid, reason: slot.reason,
        idleMs: slot.idleMs, children: slot.children.length } });
    if (ok === false) throw new Error('Daemon event append failed; emission state was not advanced');
    entries.set(key, now);
    while (entries.size > 200) entries.delete(entries.keys().next().value);
    await saveState(Object.fromEntries(entries));
  }
  return Object.fromEntries(entries);
}

export function formatSlotReport(report) {
  const lines = ['PR HEAD STATUS PID ALIVE ADMITTED IDLE STUCK CHILDREN (depth<=6, max 20; commands<=160 chars)'];
  for (const slot of report.slots) lines.push([
    `${slot.repo}#${slot.pr}`, String(slot.head).slice(0, 7), slot.status, slot.pid ?? '-',
    slot.pidAlive ?? 'unknown', slot.admittedAt, `${Math.floor(slot.idleMs / 1000)}s`,
    slot.reason ? `STUCK ${slot.reason}` : '-', slot.children.map(child => `${child.pid}:${child.command}`).join(' | ') || '-',
  ].map(clean).join(' '));
  lines.push(`ancientOrphans=${report.ancientOrphans} stuckAfterMs=${report.stuckAfterMs}`);
  for (const row of report.queuedNotRunning) lines.push(`queuedNotRunning ${clean(row.key)} ${clean(row.head)} attempts=${clean(row.attempts)}`);
  return lines.join('\n');
}

function readOptionalJson(path, fallback) {
  try {
    if (statSync(path).size > 8 * 1024 * 1024) throw new Error('Oversized JSON evidence; inspect file manually');
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export async function runSlotCli(argv = process.argv.slice(2)) {
  if (argv.some(arg => !['--json', '--emit'].includes(arg))) throw new Error('Usage: red-team-slots.mjs [--json] [--emit]');
  const env = process.env;
  const now = Date.now();
  const dir = env.WE_RED_TEAM_STATUS_DIR || redTeamStatusDir(env);
  const settings = resolveSlotThreshold({ file: readOptionalJson(RED_TEAM_SETTINGS_FILE, {}),
    platform: platformPreference('redTeam', { env }), env });
  console.error(formatCascadeSourcesLine('redTeam', settings));
  const statuses = readSlotStatuses(dir, { now });
  const queueRows = readOptionalJson(defaultQueueFile(env), []);
  if (!Array.isArray(queueRows) || queueRows.some(row => !row?.key || !row.repo || !row.pr || !row.head
    || !Number.isInteger(row.attempts))) throw new Error('Invalid dispatch queue; inspect queue file manually');
  const psRows = parseSlotPsRows(execFileSync('ps', ['-axo', 'pid=,ppid=,etime=,command='], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const host = hostname(), namespace = pidNamespace();
  const report = buildSlotReport({ statuses, psRows, queueRows, now,
    stuckAfterMs: settings.value.slotStuckAfterMs,
    aliveFn: status => probeSlotAlive(status, { host, namespace, killAlive: pidAlive, readStart: pidStartTime }) });
  if (argv.includes('--emit')) {
    const path = join(dirname(dir), 'red-team-slots-emitted.json');
    const state = readOptionalJson(path, {});
    if (!state || Array.isArray(state) || typeof state !== 'object') throw new Error('Invalid emission state; inspect state file manually');
    await emitStuckSlots(report.stuck, { state, now, appendEvent: appendDaemonEvent,
      saveState: value => {
        const temp = `${path}.${process.pid}.tmp`;
        writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
        renameSync(temp, path);
      } });
  }
  console.log(argv.includes('--json') ? JSON.stringify(report, null, 2) : formatSlotReport(report));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSlotCli().catch(error => { console.error(clean(error.message)); process.exitCode = 1; });
}
