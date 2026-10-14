/** Holder attribution, bounded holds and caller admission for the shared gh semaphore. */
import { basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readLockEntry, releaseLockDirIf } from '../readiness/file-locks.mjs';
import { slotPath } from '../readiness/heavy-admission.mjs';
import { readDeclaredSettings } from './settings-files.mjs';
import { cascadePolicy } from './policy-cascade.mjs';

export const GH_HOLDER_DEFAULTS = Object.freeze({ maxHoldSeconds: 90, reapGraceSeconds: 15, perCallerMax: 4 });
const cached = new WeakMap();
export function loadGhThrottleSettings({ file, env = process.env } = {}) {
  const settings = file ?? readDeclaredSettings().settings;
  const number = (key) => env[key] == null || env[key] === '' ? undefined : Number(env[key]);
  return cascadePolicy('ghThrottle', settings?.ghThrottle, {
    env, standard: GH_HOLDER_DEFAULTS,
    envValues: { maxHoldSeconds: number('WE_GH_THROTTLE_MAX_HOLD_SECONDS'), perCallerMax: number('WE_GH_THROTTLE_PER_CALLER_MAX') },
    valid: (v) => Number.isFinite(v) && v >= 0 && Number.isInteger(v),
  });
}
export function ghHolderPolicy(env = process.env) {
  if (!cached.has(env)) cached.set(env, loadGhThrottleSettings({ env }).value);
  return cached.get(env);
}

export function redactGhArgs(args = []) {
  const scrub = (s) => s.replace(/gh[pousr]_[a-zA-Z0-9_]+|github_pat_[a-zA-Z0-9_]+|Bearer\s+(?:"[^"]*"|'[^']*'|[^\s]+)|token=(?:"[^"]*"|'[^']*'|[^\s&]+)/gi, '<redacted>');
  return scrub(args.map((arg, i) => {
    const s = String(arg), prev = String(args[i - 1] ?? '');
    const header = ['-H', '--header'].includes(prev) || /^(?:-H|--header=)/.test(s);
    if (header && /authorization/i.test(s)) return '<redacted>';
    const field = ['-f', '-F', '--field', '--raw-field'].includes(prev) || /^(?:-[fF]|--(?:raw-)?field=)/.test(s);
    const key = s.replace(/^(?:-[fF]|--(?:raw-)?field=)/, '').split('=')[0];
    if (field && /token|secret|password/i.test(key)) return '<redacted>';
    return s;
  }).join(' ')).slice(0, 300);
}
export function ghHolderMeta({ caller, args, pid = process.pid, ppid = process.ppid, nowMs = Date.now() }) {
  return { caller, op: redactGhArgs(args), pid, ppid, parent: basename(process.argv[1] || ''), acquiredAt: new Date(nowMs).toISOString() };
}
export function isGhWatch(args) { return args?.includes('--watch') || (args?.[0] === 'run' && args?.[1] === 'watch'); }
export function ghExecOptions(opts, args, policy) {
  if (isGhWatch(args)) { const { timeout, ...rest } = opts; return rest; }
  return policy.maxHoldSeconds > 0 && opts.timeout === undefined ? { ...opts, timeout: policy.maxHoldSeconds * 1000, killSignal: 'SIGTERM' } : opts;
}
export function ghCallHoldFields(args, error) {
  return { ...(isGhWatch(args) ? { unslotted: 'watch' } : {}), ...(error?.code === 'ETIMEDOUT' ? { timedOut: true } : {}) };
}
export function ghCallerKey({ caller, ppid }) {
  return ['', 'unknown', 'node', 'gh-throttle.mjs'].includes(caller ?? '') ? `ppid:${ppid}` : caller;
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function holder(slot, entry, nowMs) {
  const m = entry.meta || {};
  const acquired = Date.parse(m.acquiredAt || entry.heartbeatAt);
  return { slot, pid: entry.pid, alive: alive(entry.pid), caller: m.caller ?? 'unknown', op: m.op ?? '', parent: m.parent ?? '', ppid: m.ppid ?? null, heldMs: Number.isFinite(acquired) ? Math.max(0, nowMs - acquired) : 0 };
}
export function readGhSlotHolders({ lockRoot, cap, nowMs = Date.now() }) {
  return Array.from({ length: cap }, (_, slot) => { const e = readLockEntry(lockRoot, slotPath(slot)); return e ? holder(slot, e, nowMs) : null; }).filter(Boolean);
}
export function ghHoldersSummary(holders = []) {
  return holders.map((h) => `${h.caller}(${h.op.slice(0, 60).replace(/[\r\n]/g, ' ')}${h.op.length > 60 ? '…' : ''}, ${Math.round(h.heldMs / 1000)}s)`).join(' ');
}

/** A holder from older code has no meta. Only on a timeout (never per poll), name it from the process table:
 *  its own command and its parent's, so the stall report still says who holds the slot. Best-effort. */
export function describeLegacyHolders(holders, ps = (pid) => execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 })) {
  const look = (pid) => { try { const m = /^\s*(\d+)\s+(.*)$/.exec(ps(pid).trim()); return m ? { ppid: Number(m[1]), cmd: m[2].slice(0, 200) } : null; } catch { return null; } };
  return holders.map((h) => {
    if (h.caller !== 'unknown' || h.op || !h.alive) return h;
    const self = look(h.pid); if (!self) return h;
    const parent = self.ppid > 1 ? look(self.ppid) : null;
    return { ...h, ppid: self.ppid, op: self.cmd, parent: parent ? parent.cmd : '' };
  });
}

/** Each poll snapshots and checks attribution before attempting the existing atomic slot primitive. */
export function acquireGhHolderSlot({ lockRoot, cap, owner, pid, pollMs, timeoutMs, now, sleep, meta, policy, trySlot, onReap = () => {} }) {
  const startedAt = now();
  for (;;) {
    const nowMs = now();
    const entries = Array.from({ length: cap }, (_, slot) => readLockEntry(lockRoot, slotPath(slot)));
    let holders = entries.flatMap((e, slot) => e ? [holder(slot, e, nowMs)] : []);
    const capped = () => policy.perCallerMax > 0 && holders.filter((h) => h.alive && ghCallerKey(h) === ghCallerKey(meta)).length >= policy.perCallerMax;
    let r = capped() ? { ok: false } : trySlot({ lockRoot, cap, owner, pid, nowMs, nowIso: new Date(nowMs).toISOString(), meta: { ...meta, acquiredAt: new Date(nowMs).toISOString() } });
    if (!r.ok && holders.length >= cap && policy.maxHoldSeconds > 0) {
      for (const h of holders) {
        if (h.heldMs <= (policy.maxHoldSeconds + policy.reapGraceSeconds) * 1000) continue;
        const entry = readLockEntry(lockRoot, slotPath(h.slot));
        if (!entry || entry.owner !== entries[h.slot]?.owner || entry.heartbeatAt !== entries[h.slot]?.heartbeatAt || holder(h.slot, entry, nowMs).heldMs <= (policy.maxHoldSeconds + policy.reapGraceSeconds) * 1000) continue;
        if (releaseLockDirIf(lockRoot, slotPath(h.slot), entry)) onReap(holder(h.slot, entry, nowMs));
      }
      holders = readGhSlotHolders({ lockRoot, cap, nowMs });
      if (!capped()) r = trySlot({ lockRoot, cap, owner, pid, nowMs, nowIso: new Date(nowMs).toISOString(), meta: { ...meta, acquiredAt: new Date(nowMs).toISOString() } });
    }
    if (r.ok) return { ok: true, slot: r.slot, timedOut: false, waitedMs: nowMs - startedAt };
    if (nowMs - startedAt >= timeoutMs) return { ok: false, slot: null, timedOut: true, waitedMs: nowMs - startedAt, holders: describeLegacyHolders(holders) };
    sleep(pollMs);
  }
}
