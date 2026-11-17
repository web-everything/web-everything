/** Holder attribution, bounded holds and caller admission for the shared gh semaphore. */
import fs, { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { URL as NodeURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readLockEntry, releaseLockDirIf } from '../readiness/file-locks.mjs';
import { slotPath } from '../readiness/heavy-admission.mjs';
import { readDeclaredSettings } from './settings-files.mjs';
import { cascadePolicy, logCascadeSources } from './policy-cascade.mjs';
import { ghCommandWords } from './gh-argv.mjs';
export { ghCommandWords } from './gh-argv.mjs';

export const DEFAULT_GH_CONCURRENCY_CAP = 6;
export const GH_SLOT_WAIT_TOOL_FILE = fileURLToPath(new NodeURL('../settings/gh-throttle.json', import.meta.url));

/** Resolve default → tool → env, retaining provenance. `tool` injects the ghThrottle block;
 *  `toolFile` injects its JSON file. Read fresh on every call; missing files contribute no override. */
export function resolveGhCapDetailed(env = process.env, { tool, toolFile = GH_SLOT_WAIT_TOOL_FILE } = {}) {
  let result = { cap: DEFAULT_GH_CONCURRENCY_CAP, source: 'default' };
  const warn = source => process.stderr.write(`gh-throttle: invalid ${source} ghThrottle.cap; expected an integer 1..50; falling back to lower layer\n`);
  if (tool === undefined) {
    try {
      tool = JSON.parse(fs.readFileSync(toolFile, 'utf8'))?.ghThrottle;
    } catch (error) {
      if (error.code !== 'ENOENT') warn('tool');
    }
  }
  const apply = (raw, source) => {
    // Only env strings are coerced: JSON booleans/null/strings are not integer settings.
    const n = source === 'env' && typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    if (Number.isInteger(n) && n >= 1 && n <= 50) result = { cap: n, source };
    else warn(source);
  };
  if (tool && Object.hasOwn(tool, 'cap')) apply(tool.cap, 'tool');
  if (env && Object.hasOwn(env, 'WE_GH_THROTTLE_CAP')) apply(env.WE_GH_THROTTLE_CAP, 'env');
  return result;
}

export function resolveGhCap(env = process.env, options = {}) {
  return resolveGhCapDetailed(env, options).cap;
}

export const GH_HOLDER_DEFAULTS = Object.freeze({ maxHoldSeconds: 90, reapGraceSeconds: 15, perCallerMax: 4, installationCap: 12, sharedFallbackCap: 6 });
const cached = new WeakMap();
export function loadGhThrottleSettings({ file, env = process.env } = {}) {
  const settings = file ?? readDeclaredSettings().settings;
  const number = (key) => env[key] == null || env[key] === '' ? undefined : Number(env[key]);
  return cascadePolicy('ghThrottle', settings?.ghThrottle, {
    env, standard: GH_HOLDER_DEFAULTS,
    envValues: { maxHoldSeconds: number('WE_GH_THROTTLE_MAX_HOLD_SECONDS'), perCallerMax: number('WE_GH_THROTTLE_PER_CALLER_MAX'), installationCap: number('WE_GH_THROTTLE_INSTALLATION_CAP'), sharedFallbackCap: number('WE_GH_THROTTLE_SHARED_FALLBACK_CAP') },
    valid: Object.fromEntries(Object.keys(GH_HOLDER_DEFAULTS).map(key => [key, v => Number.isInteger(v) && (['installationCap', 'sharedFallbackCap'].includes(key) ? v >= 1 && v <= 50 : v >= 0)])),
  });
}
function holderSettings(env) {
  if (!cached.has(env)) cached.set(env, loadGhThrottleSettings({ env }));
  return cached.get(env);
}
export function ghHolderPolicy(env = process.env) {
  return holderSettings(env).value;
}

/** Effective cap for EACH installation; there is deliberately no aggregate installation ceiling. */
export function ghInstallationCap({ cap, explicitCap = false, env = process.env, settings = holderSettings(env), global = resolveGhCapDetailed(env) }) {
  const source = settings.sources.installationCap;
  // An explicit global cap from caller, tool or env bounds each installation.
  const globalCap = explicitCap ? cap : (global.source !== 'default' ? global.cap : null);
  const value = globalCap == null ? settings.value.installationCap : Math.min(settings.value.installationCap, globalCap);
  logCascadeSources('ghThrottle.slotCap', { value: { installationCap: value }, sources: { installationCap: globalCap != null && globalCap < settings.value.installationCap ? (explicitCap ? 'caller' : global.source) : source }, invalid: [] }, { env });
  return value;
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
  return { ...(h.bucket === 'shared' || /^\d+$/.test(h.bucket ?? '') ? { bucket: h.bucket } : {}), slot: integer(h.slot, 0), pid: integer(h.pid, 1), alive: h.alive === true, caller: sanitizeHolderField(h.caller), op,
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
  return sanitizeGhHolder({ slot, pid: entry.pid, alive: alive(entry.pid), caller: m.caller ?? 'unknown', op: m.op ?? m.args ?? '', parent: m.parent ?? '', ppid: m.ppid ?? null, heldMs: Number.isFinite(acquired) ? Math.max(0, nowMs - acquired) : 0, timeoutMs: m.timeoutMs });
}
/** Shared pool descriptor used by acquisition and release. Unknown labels keep the legacy pool. */
export function ghSlotPool({ lockRoot, cap, bucket, installationCap = 12, sharedFallbackCap = 6 }) {
  return typeof bucket === 'string' && /^\d+$/.test(bucket)
    ? { lockRoot: join(lockRoot, 'installations', bucket), cap: installationCap, bucket, callerLockRoot: lockRoot }
    : { lockRoot, cap: Math.min(cap, sharedFallbackCap), bucket: 'shared', callerLockRoot: lockRoot };
}

/** Numeric directories only; unrelated budget/log files can never become pools. */
export function ghInstallationPools(lockRoot) {
  try { return readdirSync(join(lockRoot, 'installations'), { withFileTypes: true }).filter(e => e.isDirectory() && /^\d+$/.test(e.name)).map(e => e.name); }
  catch { return []; }
}

export function readGhSlotHolders({ lockRoot, cap, env = process.env, installationCap = ghInstallationCap({ cap, env }), nowMs = Date.now(), includeInstallations = true }) {
  const read = (root, limit, bucket) => {
    // Include reserved and persisted slots after a cap reduction, without inventing free capacity.
    // Lock directories are hashed by file-locks, so probe logical slot paths. The setting's
    // upper bound is 50 ordinary slots plus one reserved slot, including historical larger caps.
    const slots = Array.from({ length: Math.max(limit, 51) }, (_, i) => i);
    return slots.flatMap(slot => { const e = readLockEntry(root, slotPath(slot)); return e ? [{ ...holder(slot, e, nowMs), ...(bucket ? { bucket } : {}) }] : []; });
  };
  return [...read(lockRoot, cap), ...(includeInstallations ? ghInstallationPools(lockRoot).flatMap(bucket => read(join(lockRoot, 'installations', bucket), installationCap, bucket)) : [])];
}
export function ghHoldersSummary(holders = []) {
  return holders.map(sanitizeGhHolder).map(h => `${h.bucket ? `[${h.bucket}] ` : ''}${h.caller}(${h.op}, ${Math.round(h.heldMs / 1000)}s)`).join(' ');
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
export function acquireGhHolderSlot({ lockRoot, cap, owner, pid, pollMs, timeoutMs, now, sleep, meta, policy, trySlot, onReap = () => {}, onWait = () => {}, callerLockRoot = lockRoot }) {
  const startedAt = now();
  const safe = sanitizeGhHolder(meta);
  const slotMeta = { caller: safe.caller, op: safe.op, args: safe.args, parent: safe.parent, pid, ppid: safe.ppid, ...(safe.timeoutMs !== undefined ? { timeoutMs: safe.timeoutMs } : {}) };
  const overAge = h => h.timeoutMs !== 0 && h.heldMs > Math.max(policy.maxHoldSeconds * 1000, h.timeoutMs ?? 0) + policy.reapGraceSeconds * 1000;
  for (;;) {
    const nowMs = now();
    const entries = Array.from({ length: cap }, (_, slot) => readLockEntry(lockRoot, slotPath(slot)));
    let holders = entries.flatMap((e, slot) => e ? [holder(slot, e, nowMs)] : []);
    // Snapshot other pools before trying admission, just as for the own-pool entries.
    const others = policy.perCallerMax > 0 ? readGhSlotHolders({ lockRoot: callerLockRoot, cap, nowMs })
      .map(h => ({ root: h.bucket ? join(callerLockRoot, 'installations', h.bucket) : callerLockRoot, ...h }))
      .filter(h => h.root !== lockRoot)
      .map(h => ({ ...h, entry: readLockEntry(h.root, slotPath(h.slot)) })) : [];
    const reap = (root, slot, snapshot, bucket) => {
      if (policy.maxHoldSeconds <= 0 || !snapshot || !overAge(holder(slot, snapshot, nowMs))) return;
      const entry = readLockEntry(root, slotPath(slot));
      if (!entry || entry.owner !== snapshot.owner || entry.heartbeatAt !== snapshot.heartbeatAt || !overAge(holder(slot, entry, nowMs))) return;
      if (releaseLockDirIf(root, slotPath(slot), entry)) onReap({ ...holder(slot, entry, nowMs), ...(bucket ? { bucket } : {}) });
    };
    // The caller bound counts every alive holder across the shared and installation pools.
    const capped = () => policy.perCallerMax > 0 && readGhSlotHolders({ lockRoot: callerLockRoot, cap, nowMs }).filter(h => h.alive && ghCallerKey(h) === ghCallerKey(slotMeta)).length >= policy.perCallerMax;
    let r = capped() ? { ok: false } : trySlot({ lockRoot, cap, owner, pid, nowMs, nowIso: new Date(nowMs).toISOString(), meta: { ...slotMeta, acquiredAt: new Date(nowMs).toISOString() } });
    if (!r.ok && (capped() || holders.length >= cap) && policy.maxHoldSeconds > 0) {
      for (const h of holders) reap(lockRoot, h.slot, entries[h.slot]);
      for (const h of others) reap(h.root, h.slot, h.entry, h.bucket ?? 'shared');
      holders = readGhSlotHolders({ lockRoot, cap, nowMs, includeInstallations: false });
      if (!capped()) r = trySlot({ lockRoot, cap, owner, pid, nowMs, nowIso: new Date(nowMs).toISOString(), meta: { ...slotMeta, acquiredAt: new Date(nowMs).toISOString() } });
    }
    if (r.ok) return { ok: true, slot: r.slot, timedOut: false, waitedMs: nowMs - startedAt };
    onWait();
    if (nowMs - startedAt >= timeoutMs) return { ok: false, slot: null, timedOut: true, waitedMs: nowMs - startedAt, holders: describeLegacyHolders(holders) };
    sleep(pollMs);
  }
}
