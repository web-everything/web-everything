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

// Telemetry records command vocabulary only. Endpoints, flags, fields, headers and positional
// payloads are deliberately omitted: a credential denylist cannot make arbitrary argv safe.
const commands = new Set('api auth browse cache codespace completion config extension gist gpg-key issue label org pr project release repo ruleset run search secret ssh-key status variable workflow'.split(' '));
const verbs = new Set('add archive cancel checks clone close comment create delete diff download edit export fork get import inspect list lock login logout merge pin ready rename reopen rerun restore review set setup-git show status sync unlock unpin upload view watch'.split(' '));
export function ghOpLabel(args = []) {
  if (!Array.isArray(args) || !commands.has(args[0])) return 'unknown';
  return args[0] !== 'api' && verbs.has(args[1]) ? `${args[0]} ${args[1]}` : args[0];
}
export function redactGhArgs(args = []) { return `${ghOpLabel(args)}${args.length > 1 ? ' <redacted>' : ''}`; }

/** Single output boundary for both current metadata and old lock/ps data. Never retain command tails. */
export function sanitizeHolderField(value, kind = 'identity') {
  const s = typeof value === 'string' ? value : '';
  if (kind === 'op') {
    const words = s.slice(0, 4096).trim().split(/\s+/);
    const executable = words.findIndex(w => ['gh', 'gh-throttle.mjs'].includes(basename(w)));
    return ghOpLabel(executable < 0 ? words : words.slice(executable + 1));
  }
  if (kind === 'parent') {
    const words = s.slice(0, 4096).trim().split(/\s+/);
    const executable = basename(words[0] || '');
    // Only node's immediate script position is attribution. Searching later arguments can
    // mistake a credential value ending in .mjs for the parent script (e.g. node -e ...).
    const script = ['node', 'nodejs', 'bun'].includes(executable) && words[1] && !words[1].startsWith('-') && /\.(?:mjs|cjs|js)$/.test(words[1]) ? words[1] : words[0];
    return sanitizeHolderField(basename(script || ''));
  }
  return /^[a-zA-Z0-9_./:@-]{1,128}$/.test(s) && !/gh[pousr]_|github_pat_/i.test(s) ? s : 'unknown';
}
export function sanitizeGhHolder(h) {
  const op = sanitizeHolderField(h.op || h.args, 'op');
  const integer = (v, min) => Number.isInteger(v) && v >= min ? v : null;
  return { slot: integer(h.slot, 0), pid: integer(h.pid, 1), alive: h.alive === true, caller: sanitizeHolderField(h.caller), op,
    args: `${op} <redacted>`, parent: sanitizeHolderField(h.parent, 'parent'), ppid: integer(h.ppid, 1),
    heldMs: Number.isFinite(h.heldMs) && h.heldMs >= 0 ? h.heldMs : 0, ...(Number.isFinite(h.timeoutMs) && h.timeoutMs >= 0 ? { timeoutMs: h.timeoutMs } : {}) };
}
export function ghHolderMeta({ caller, args, pid = process.pid, ppid = process.ppid, nowMs = Date.now(), timeoutMs }) {
  return { caller: sanitizeHolderField(caller), op: ghOpLabel(args), args: redactGhArgs(args), pid, ppid,
    parent: sanitizeHolderField(basename(process.argv[1] || ''), 'parent'), acquiredAt: new Date(nowMs).toISOString(),
    ...(Number.isFinite(timeoutMs) && timeoutMs >= 0 ? { timeoutMs } : {}) };
}
export function isGhWatch(args) { return args?.includes('--watch') || (args?.[0] === 'run' && args?.[1] === 'watch'); }
export function ghExecOptions(opts, args, policy) {
  if (isGhWatch(args)) { const { timeout, ...rest } = opts; return rest; }
  return policy.maxHoldSeconds > 0 && opts.timeout === undefined ? { ...opts, timeout: policy.maxHoldSeconds * 1000, killSignal: opts.killSignal ?? 'SIGTERM' } : opts;
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
  return sanitizeGhHolder({ slot, pid: entry.pid, alive: alive(entry.pid), caller: m.caller ?? 'unknown', op: m.op ?? m.args ?? '', parent: m.parent ?? '', ppid: m.ppid ?? null, heldMs: Number.isFinite(acquired) ? Math.max(0, nowMs - acquired) : 0, timeoutMs: m.timeoutMs });
}
export function readGhSlotHolders({ lockRoot, cap, nowMs = Date.now() }) {
  return Array.from({ length: cap }, (_, slot) => { const e = readLockEntry(lockRoot, slotPath(slot)); return e ? holder(slot, e, nowMs) : null; }).filter(Boolean);
}
export function ghHoldersSummary(holders = []) {
  return holders.map(sanitizeGhHolder).map(h => `${h.caller}(${h.op}, ${Math.round(h.heldMs / 1000)}s)`).join(' ');
}

/** A holder from older code has no meta. Only on a timeout (never per poll), name it from the process table:
 *  its own command and its parent's, so the stall report still says who holds the slot. Best-effort. */
export function describeLegacyHolders(holders, ps = (pid) => execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 })) {
  const look = (pid) => { try { const m = /^\s*(\d+)\s+([\s\S]*)$/.exec(ps(pid).trim()); return m ? { ppid: Number(m[1]), cmd: m[2] } : null; } catch { return null; } };
  return holders.map((h) => {
    if (h.caller !== 'unknown' || (h.op && h.op !== 'unknown') || !h.alive) return sanitizeGhHolder(h);
    const self = look(h.pid); if (!self) return sanitizeGhHolder(h);
    const parent = self.ppid > 1 ? look(self.ppid) : null;
    return sanitizeGhHolder({ ...h, ppid: self.ppid, op: self.cmd, parent: parent ? parent.cmd : '' });
  });
}

/** Each poll snapshots and checks attribution before attempting the existing atomic slot primitive. */
export function acquireGhHolderSlot({ lockRoot, cap, owner, pid, pollMs, timeoutMs, now, sleep, meta, policy, trySlot, onReap = () => {} }) {
  const startedAt = now();
  const safe = sanitizeGhHolder(meta);
  const slotMeta = { caller: safe.caller, op: safe.op, args: safe.args, parent: safe.parent, pid, ppid: safe.ppid, ...(safe.timeoutMs !== undefined ? { timeoutMs: safe.timeoutMs } : {}) };
  const overAge = h => h.timeoutMs !== 0 && h.heldMs > Math.max(policy.maxHoldSeconds * 1000, h.timeoutMs ?? 0) + policy.reapGraceSeconds * 1000;
  for (;;) {
    const nowMs = now();
    const entries = Array.from({ length: cap }, (_, slot) => readLockEntry(lockRoot, slotPath(slot)));
    let holders = entries.flatMap((e, slot) => e ? [holder(slot, e, nowMs)] : []);
    const capped = () => policy.perCallerMax > 0 && holders.filter((h) => h.alive && ghCallerKey(h) === ghCallerKey(slotMeta)).length >= policy.perCallerMax;
    let r = capped() ? { ok: false } : trySlot({ lockRoot, cap, owner, pid, nowMs, nowIso: new Date(nowMs).toISOString(), meta: { ...slotMeta, acquiredAt: new Date(nowMs).toISOString() } });
    if (!r.ok && (capped() || holders.length >= cap) && policy.maxHoldSeconds > 0) {
      for (const h of holders) {
        if (!overAge(h)) continue;
        const entry = readLockEntry(lockRoot, slotPath(h.slot));
        if (!entry || entry.owner !== entries[h.slot]?.owner || entry.heartbeatAt !== entries[h.slot]?.heartbeatAt || !overAge(holder(h.slot, entry, nowMs))) continue;
        if (releaseLockDirIf(lockRoot, slotPath(h.slot), entry)) onReap(holder(h.slot, entry, nowMs));
      }
      holders = readGhSlotHolders({ lockRoot, cap, nowMs });
      if (!capped()) r = trySlot({ lockRoot, cap, owner, pid, nowMs, nowIso: new Date(nowMs).toISOString(), meta: { ...slotMeta, acquiredAt: new Date(nowMs).toISOString() } });
    }
    if (r.ok) return { ok: true, slot: r.slot, timedOut: false, waitedMs: nowMs - startedAt };
    if (nowMs - startedAt >= timeoutMs) return { ok: false, slot: null, timedOut: true, waitedMs: nowMs - startedAt, holders: describeLegacyHolders(holders) };
    sleep(pollMs);
  }
}
