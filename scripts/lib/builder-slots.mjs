/** Host-shared builder leases for orchestrator launches. Corrupt/unreadable evidence refuses acquisition. */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { hostname as machineHostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { defaultPoolRoot } from './lane-pool-paths.mjs';
import { countBuilderClasses, executorClass } from '../conveyor/build-dispatch-policy.mjs';
import { readBuilderSlotSettings } from './builder-slots-settings.mjs';

const sleepDefault = ms => new Promise(resolve => setTimeout(resolve, ms));
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
function checkoutTop(cwd = process.cwd()) {
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || cwd; } catch { return cwd; }
}
export const builderSlotsRoot = (checkoutRoot = checkoutTop(), env = process.env) => env.WE_BUILDER_SLOTS_ROOT || join(defaultPoolRoot(checkoutRoot, env), '.admission/builders');
const options = o => ({ root: builderSlotsRoot(), now: Date.now, isPidAlive: pidAlive, hostname: machineHostname(), ...o });
const pathFor = (root, id) => { if (!/^[a-f0-9]+$/.test(id)) throw new Error('Invalid builder slot id'); return join(root, `${id}.json`); };
function remove(path) { try { unlinkSync(path); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
function atomic(root, rec) {
  const path = pathFor(root, rec.id), tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(rec), { flag: 'wx', mode: 0o600 }); renameSync(tmp, path); } finally { remove(tmp); }
}
function validateRecord(rec, name) {
  if (!rec || name !== `${rec.id}.json` || !['claude', 'codex', 'antigravity'].includes(rec.class)
      || typeof rec.purpose !== 'string' || typeof rec.host !== 'string'
      || !(rec.pid === null || (Number.isSafeInteger(rec.pid) && rec.pid > 0)) || !Number.isFinite(rec.startedAt)
      || !Number.isFinite(rec.heartbeatAt) || !Number.isFinite(rec.ttlMs) || rec.ttlMs < 1000) throw new Error('Invalid builder slot record');
  return rec;
}
export function isStale(rec, now = Date.now(), { hostname = machineHostname(), isPidAlive = pidAlive, settings, maxAgeMs = (settings ?? readBuilderSlotSettings()).maxAgeMs } = {}) {
  if (rec.pid && rec.host === hostname) return !isPidAlive(rec.pid) || now - rec.startedAt > maxAgeMs;
  return rec.heartbeatAt + rec.ttlMs < now;
}
export function listSlots(o = {}) {
  const { root, now, ...probe } = options(o);
  let names;
  try { names = readdirSync(root); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return names.filter(n => n.endsWith('.json')).flatMap(name => {
    let rec;
    try { rec = JSON.parse(readFileSync(join(root, name), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    validateRecord(rec, name);
    const stale = isStale(rec, now(), probe);
    if (stale) {
      // Re-read right before deleting: a heartbeat may have renewed the lease since the snapshot above.
      let again = null;
      try { again = validateRecord(JSON.parse(readFileSync(join(root, name), 'utf8')), name); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (again && isStale(again, now(), probe)) remove(join(root, name));
      else if (again) return [{ ...again, stale: false }];
    }
    return [{ ...rec, stale }];
  });
}
export async function acquireSlot(o = {}) {
  const settings = o.settings ?? readBuilderSlotSettings();
  if (!settings.enabled) return { ok: true, id: 'disabled', record: null };
  const p = options(o), { root, now, hostname } = p;
  const kind = o.class;
  if (o.purpose !== undefined && typeof o.purpose !== 'string') throw new Error('Invalid builder slot purpose');
  if (o.pid != null && (!Number.isSafeInteger(o.pid) || o.pid < 1)) throw new Error('Invalid builder slot pid');
  if (!['claude', 'codex', 'antigravity'].includes(kind)) throw new Error('Invalid builder class');
  const caps = o.caps ?? { claude: settings.maxClaude, codex: settings.maxExternal };
  const cap = kind === 'claude' ? (caps.claude ?? caps.maxClaude) : (caps.codex ?? caps.external ?? caps.maxExternal);
  const ttlMs = o.ttlMs ?? settings.ttlMs;
  if (!Number.isSafeInteger(cap) || cap < 0 || !Number.isSafeInteger(ttlMs) || ttlMs < 1000) throw new Error('Invalid builder slot bounds');
  try {
    mkdirSync(root, { recursive: true });
    const lock = join(root, '.lock');
    const lockStart = now();
    for (;;) {
      try { mkdirSync(lock); break; } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try { if (now() - statSync(lock).mtimeMs > 10000) { rmSync(lock, { recursive: true, force: true }); continue; } } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
        if (now() - lockStart > 11000) throw new Error('Builder slot mutex busy; retry acquisition');
        await (o.sleep ?? sleepDefault)(20);
      }
    }
    try {
      const live = listSlots(p).filter(r => !r.stale);
      const holders = live.filter(r => executorClass(r.class) === executorClass(kind));
      const counts = countBuilderClasses([...(o.inFlightRows ? await o.inFlightRows() : []), ...live.map(r => ({ num: `slot-${r.id}`, executor: r.class }))]);
      if (counts[executorClass(kind)] >= cap) return { ok: false, reason: 'full', class: kind, cap, counts, holders };
      const id = randomBytes(6).toString('hex'), at = now();
      const record = { id, class: kind, purpose: o.purpose ?? '', pid: o.pid ?? null, host: hostname, startedAt: at, heartbeatAt: at, ttlMs };
      atomic(root, record);
      return { ok: true, id, record };
    } finally { rmSync(lock, { recursive: true, force: true }); }
  } catch (e) { return { ok: false, reason: 'unreadable', error: String(e?.message ?? e).split('\n')[0].replace(/[\p{Cc}\p{Cf}]/gu, '') || 'unknown error' }; }
}
export function heartbeatSlot(id, o = {}) {
  if (id === 'disabled' || (o.settings ?? readBuilderSlotSettings()).enabled === false) return;
  const { root, now } = options(o);
  let rec;
  try { rec = JSON.parse(readFileSync(pathFor(root, id), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  atomic(root, { ...rec, heartbeatAt: now() });
}
export function releaseSlot(id, o = {}) {
  if (id === 'disabled' || (o.settings ?? readBuilderSlotSettings()).enabled === false) return;
  remove(pathFor(options(o).root, id));
}
export function liveBuilderSlotRows(o = {}) {
  const settings = o.settings ?? readBuilderSlotSettings();
  if (!settings.enabled) return [];
  return listSlots(o).filter(r => !r.stale).map(r => ({ num: `slot-${r.id}`, scope: [], source: `builder slot ${r.purpose} ${r.id}`, executor: r.class, borrowedFix: true }));
}
export async function waitForSlot(o = {}) {
  const now = o.now ?? Date.now, sleep = o.sleep ?? sleepDefault;
  const waitMs = o.waitMs ?? (o.settings ?? readBuilderSlotSettings()).waitMs;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0) throw new Error('Invalid builder slot wait budget');
  const pollMs = o.pollMs ?? 2000;
  if (!Number.isSafeInteger(pollMs) || pollMs < 1) throw new Error('Invalid builder slot poll interval');
  const start = now(); let lastNotice = -Infinity;
  for (;;) {
    const result = await acquireSlot(o);
    if (result.ok || result.reason === 'unreadable') return result;
    const at = now();
    if (at - start >= waitMs) return { ...result, reason: 'wait-budget' };
    if (at - lastNotice >= 60000) { o.onWaiting?.(result); lastNotice = at; }
    await sleep(Math.min(pollMs, waitMs - (at - start)));
  }
}
