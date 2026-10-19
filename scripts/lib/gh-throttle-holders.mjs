/** Holder attribution, bounded holds and caller admission for the shared gh semaphore. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readLockEntry, releaseLockDirIf, reserve, reclaimDecision } from '../readiness/file-locks.mjs';
import { slotPath, ADMISSION_LEASE_MINUTES } from '../readiness/heavy-admission.mjs';
import { readDeclaredSettings } from './settings-files.mjs';
import { cascadePolicy } from './policy-cascade.mjs';
import { ghCommandWords } from './gh-argv.mjs';
export { ghCommandWords } from './gh-argv.mjs';

export const GH_HOLDER_DEFAULTS = Object.freeze({ maxHoldSeconds: 90, reapGraceSeconds: 15, perCallerMax: 4 });
export const GH_SLOT_POOL_STANDARD = Object.freeze({ slotsPerIdentity: 6, hostMaxSlots: 24, reservedBackgroundSlots: 1 });
const cached = new WeakMap();
export function loadGhThrottleSettings({ file, env = process.env } = {}) {
  const settings = file ?? readDeclaredSettings().settings;
  const number = (key) => env?.[key] == null || String(env[key]).trim() === '' ? undefined : Number(env[key]);
  return cascadePolicy('ghThrottle', settings?.ghThrottle, {
    env, standard: { ...GH_HOLDER_DEFAULTS, ...GH_SLOT_POOL_STANDARD },
    envValues: { maxHoldSeconds: number('WE_GH_THROTTLE_MAX_HOLD_SECONDS'), perCallerMax: number('WE_GH_THROTTLE_PER_CALLER_MAX'),
      slotsPerIdentity: number('WE_GH_THROTTLE_SLOTS_PER_IDENTITY') ?? number('WE_GH_THROTTLE_CAP'),
      hostMaxSlots: number('WE_GH_THROTTLE_HOST_MAX_SLOTS'),
      reservedBackgroundSlots: number('WE_GH_THROTTLE_RESERVED_BACKGROUND_SLOTS'),
    },
    valid: Object.fromEntries(Object.keys({ ...GH_HOLDER_DEFAULTS, ...GH_SLOT_POOL_STANDARD }).map(key => [key,
      v => Number.isInteger(v) && v >= (['slotsPerIdentity', 'hostMaxSlots'].includes(key) ? 1 : 0)])),
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
/** The first two command words (`['pr', 'merge']`) as gh itself finds them. */
export function ghCommandPath(args) { return ghCommandWords(args).map(w => w.word); }
export function ghOpLabel(args = []) {
  const [cmd, verb] = ghCommandPath(args);
  if (!commands.has(cmd)) return 'unknown';
  return cmd !== 'api' && verbs.has(verb) ? `${cmd} ${verb}` : cmd;
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
  return { ...(h.pool !== undefined ? { pool: sanitizeHolderField(h.pool) } : {}), ...(h.class !== undefined ? { class: h.class === 'background' ? 'background' : 'priority' } : {}), slot: integer(h.slot, 0), pid: integer(h.pid, 1), alive: h.alive === true, caller: sanitizeHolderField(h.caller), op,
    args: `${op} <redacted>`, parent: sanitizeHolderField(h.parent, 'parent'), ppid: integer(h.ppid, 1),
    heldMs: Number.isFinite(h.heldMs) && h.heldMs >= 0 ? h.heldMs : 0, ...(Number.isFinite(h.timeoutMs) && h.timeoutMs >= 0 ? { timeoutMs: h.timeoutMs } : {}) };
}
export function ghHolderMeta({ caller, args, pid = process.pid, ppid = process.ppid, nowMs = Date.now(), timeoutMs }) {
  return { caller: sanitizeHolderField(caller), op: ghOpLabel(args), args: redactGhArgs(args), pid, ppid,
    parent: sanitizeHolderField(basename(process.argv[1] || ''), 'parent'), acquiredAt: new Date(nowMs).toISOString(),
    ...(Number.isFinite(timeoutMs) && timeoutMs >= 0 ? { timeoutMs } : {}) };
}
// The leaf's own flags are parsed by pflag over the args minus the command words: a value flag consumes
// the next argument even when it starts with `--` (`pr comment --body --watch`), a boolean also takes
// `--flag=<bool>`, the last occurrence wins, and a short group `-wR` ends at its first value flag.
// A Map, not an object literal: a command path such as `constructor` or `__proto__` must not resolve to an inherited member.
const watchLeaves = new Map([['pr checks', { long: new Set(['help', 'watch', 'fail-fast', 'required', 'web']), short: new Set(['h', 'w']) }]]);
const pflagTrue = new Set(['1', 't', 'T', 'TRUE', 'true', 'True']);
function pflagLongValue(args, bools, name) {
  let value;
  for (let i = 0; i < args.length; i++) {
    const s = String(args[i]);
    if (s === '--') break;
    if (s.startsWith('--')) {
      const eq = s.indexOf('='), key = eq < 0 ? s.slice(2) : s.slice(2, eq);
      if (eq >= 0) { if (key === name) value = s.slice(eq + 1); } else if (bools.long.has(key)) { if (key === name) value = 'true'; } else i++;
    } else if (s.length > 1 && s[0] === '-') {
      for (let j = 1; j < s.length; j++) {
        if (s[j + 1] === '=') break; // `-x=value`: the rest of the group is its value
        if (bools.short.has(s[j])) continue;
        if (j === s.length - 1) i++; // a value flag ending the group takes the next argument
        break; // otherwise the rest of the group is its value
      }
    }
  }
  return value;
}
export function isGhWatch(args) {
  const words = ghCommandWords(args);
  const path = words.map(w => w.word).join(' ');
  if (path === 'run watch') return true;
  const leaf = watchLeaves.get(path);
  if (!leaf) return false;
  const rest = args.filter((_, i) => !words.some(w => w.at === i));
  return pflagTrue.has(pflagLongValue(rest, leaf, 'watch'));
}
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
  return sanitizeGhHolder({ slot, pid: entry.pid, alive: alive(entry.pid), caller: m.caller ?? 'unknown', op: m.op ?? m.args ?? '', parent: m.parent ?? '', ppid: m.ppid ?? null, heldMs: Number.isFinite(acquired) ? Math.max(0, nowMs - acquired) : 0, timeoutMs: m.timeoutMs, pool: m.pool ?? 'default', class: m.class ?? 'priority' });
}
export function readGhSlotHolders({ lockRoot, cap, nowMs = Date.now() }) {
  return Array.from({ length: cap }, (_, slot) => { const e = readLockEntry(lockRoot, slotPath(slot)); return e ? holder(slot, e, nowMs) : null; }).filter(Boolean);
}
export function ghHoldersSummary(holders = []) {
  return holders.map(sanitizeGhHolder).map(h => `${h.caller}(${h.op}, ${Math.round(h.heldMs / 1000)}s)${h.pool ? ` pool=${h.pool}` : ''}`).join(' ');
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
export function acquireGhHolderSlot({ lockRoot, cap, owner, pid, pollMs, timeoutMs, now, sleep, meta, policy, trySlot, onReap = () => {}, poolLimits }) {
  const startedAt = now();
  const mutexOwner = randomUUID();
  if (poolLimits) mkdirSync(lockRoot, { recursive: true });
  const safe = sanitizeGhHolder(meta);
  const sanitizedPool = poolLimits ? sanitizeHolderField(poolLimits.identity) : undefined;
  const poolKey = poolLimits && sanitizedPool !== poolLimits.identity
    ? `pool-${createHash('sha256').update(poolLimits.identity).digest('hex').slice(0, 24)}` : sanitizedPool;
  const scanCap = Math.max(cap, GH_SLOT_POOL_STANDARD.hostMaxSlots, 64);
  const slotMeta = { ...(poolLimits ? { pool: poolKey, class: poolLimits.class } : {}), caller: safe.caller, op: safe.op, args: safe.args, parent: safe.parent, pid, ppid: safe.ppid, ...(safe.timeoutMs !== undefined ? { timeoutMs: safe.timeoutMs } : {}) };
  const overAge = h => h.timeoutMs !== 0 && h.heldMs > Math.max(policy.maxHoldSeconds * 1000, h.timeoutMs ?? 0) + policy.reapGraceSeconds * 1000;
  for (;;) {
    const nowMs = now();
    // Serialize the snapshot and reservation across processes: both identity quotas and the
    // host ceiling must be checked in the same critical section as the atomic slot claim.
    const mutexKey = 'identity-slot-admission';
    const locked = !poolLimits || reserve(lockRoot, mutexKey, mutexOwner, nowMs, new Date(nowMs).toISOString(), pid,
      entry => Number.isInteger(entry.pid) && entry.pid !== pid && !alive(entry.pid) ? 'dead' : 'unknown', 1).ok;
    let r = { ok: false }, holders = [];
    if (locked) try {
      const entries = Array.from({ length: scanCap }, (_, slot) => readLockEntry(lockRoot, slotPath(slot)));
      holders = entries.flatMap((e, slot) => e ? [holder(slot, e, nowMs)] : []);
      // Exclude only entries the underlying slot primitive itself can reclaim. Legacy holders
      // without identity metadata belong to the default pool during rolling upgrades.
      const occupied = () => holders.filter(h => !reclaimDecision(entries[h.slot], nowMs, owner,
        entries[h.slot].pid !== pid && Number.isInteger(entries[h.slot].pid) ? (h.alive ? 'alive' : 'dead') : 'unknown',
        ADMISSION_LEASE_MINUTES, pid).acquirable);
      const pool = () => occupied().filter(h => !poolLimits || h.pool === poolKey);
      const capped = () => (policy.perCallerMax > 0 && occupied().filter(h => h.alive && ghCallerKey(h) === ghCallerKey(slotMeta)).length >= policy.perCallerMax)
        || (poolLimits && (occupied().length >= cap || pool().length >= poolLimits.slotsPerIdentity
          || (poolLimits.class !== 'background' && pool().filter(h => h.class !== 'background').length >= poolLimits.slotsPerIdentity - poolLimits.reservedBackgroundSlots)));
      const attempt = () => capped() ? { ok: false } : trySlot({ lockRoot, cap, owner, pid, nowMs, nowIso: new Date(nowMs).toISOString(), meta: { ...slotMeta, acquiredAt: new Date(nowMs).toISOString() } });
      r = attempt();
      if (!r.ok && (capped() || holders.length >= cap) && policy.maxHoldSeconds > 0) {
        for (const h of holders) {
          if (!overAge(h)) continue;
          const entry = readLockEntry(lockRoot, slotPath(h.slot));
          if (!entry || entry.owner !== entries[h.slot]?.owner || entry.heartbeatAt !== entries[h.slot]?.heartbeatAt || !overAge(holder(h.slot, entry, nowMs))) continue;
          if (releaseLockDirIf(lockRoot, slotPath(h.slot), entry)) onReap(holder(h.slot, entry, nowMs));
        }
        holders = readGhSlotHolders({ lockRoot, cap: scanCap, nowMs });
        r = attempt();
      }
    } finally {
      if (poolLimits) releaseLockDirIf(lockRoot, mutexKey, { owner: mutexOwner });
    }
    if (r.ok) return { ok: true, slot: r.slot, timedOut: false, waitedMs: nowMs - startedAt };
    if (nowMs - startedAt >= timeoutMs) return { ok: false, slot: null, timedOut: true, waitedMs: nowMs - startedAt, holders: describeLegacyHolders(holders) };
    sleep(pollMs);
  }
}
