/**
 * Persistent throttle for health-watch's FULL stale-state lane scan (not claim/liveness reads).
 *
 * THE CACHE IS FOR REPORTING ONLY (operator ruling 2026-10-20). A row served from the cache carries `cachedAt`; the
 * stale-state reader never reports a cached row as safe (`hasUnsafeWork:false`): cached unsafe stays unsafe, cached
 * safe/unknown becomes unknown (null). Before ANY destructive action on a lane (reclaim, reset, reuse,
 * release-on-behalf) the actor must call {@link guardLaneAction}, which runs {@link freshLaneSafety} on that one lane
 * now and permits the action only on a fresh, positively-safe result; any error is unsafe.
 */
import { lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { platformPreference, resolveCascade } from './policy-cascade.mjs';
import { readDeclaredSettings } from './settings-files.mjs';
import { DIRTY_PROBE_ARGS, hasHiddenIndexFlags, laneGitEnv } from './git-transport-branch.mjs';
import { hardenLaneGitArgs, laneGitHardeningEnv, scrubInheritedGitEnv, laneFilterDrivers, configKeyCandidates, LANE_CONFIG_LIST_ARGS } from './lane-git-hardening.mjs';

export function resolveLaneScanPolicy({ env = process.env,
  platform = platformPreference('healthWatch', { env }), tool = readDeclaredSettings().settings?.healthWatch,
} = {}) {
  const raw = env.WE_HEALTH_WATCH_LANE_SCAN_INTERVAL_SEC;
  const pick = block => {
    const value = block?.laneScanIntervalSec;
    // Validate the setting as a leaf even when a malformed object was supplied.
    return value === undefined ? {} : { laneScanIntervalSec: typeof value === 'object' ? JSON.stringify(value) : value };
  };
  const result = resolveCascade({ standard: { laneScanIntervalSec: 300 }, platform: pick(platform), tool: pick(tool),
    envValues: { laneScanIntervalSec: raw === undefined ? undefined : /^\d+$/.test(raw) ? Number(raw) : raw },
    valid: { laneScanIntervalSec: v => Number.isSafeInteger(v) && v > 0 },
  });
  // This throttle deliberately falls back to the standard on invalid configuration.
  return { interval: result.invalid.length ? 300 : result.value.laneScanIntervalSec,
    source: result.invalid.length ? 'standard' : result.sources.laneScanIntervalSec, invalid: result.invalid };
}

export function cachedLaneScan(scan, { dir, root, now = Date.now(), write = true,
  policy = resolveLaneScanPolicy(), log = line => console.error(line),
} = {}) {
  const path = dir ? join(dir, 'lane-scan.json') : null;
  let cache;
  try { cache = JSON.parse(readFileSync(path, 'utf8')); } catch { /* missing/corrupt is due */ }
  const valid = cache?.version === 1 && cache.root === root && Number.isFinite(cache.at)
    && Array.isArray(cache.lanes) && cache.lanes.every(row => row?.lane && typeof row.lane === 'object' && typeof row.lane.path === 'string'
      && (row.ahead === null || Number.isSafeInteger(row.ahead) && row.ahead >= 0));
  const age = valid ? now - cache.at : NaN;
  const fresh = age >= 0 && age < policy.interval * 1000;
  const invalid = policy.invalid.length ? `, invalid setting (${policy.invalid.join('; ')}); falling back to default 300s` : '';
  log(`health-watch: lane scan ${fresh ? `skipped (age ${Math.floor(age / 1000)}s < ${policy.interval}s` : `running (due, interval=${policy.interval}s`}, source=${policy.source}${invalid})`);
  // Served rows are marked with the scan time so no reader can mistake them for a fresh safety read.
  if (fresh) return cache.lanes.map(row => ({ ...row, cachedAt: cache.at }));
  const lanes = scan();
  if (path && write) {
    const tmp = `${path}.tmp-${process.pid}`;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(tmp, JSON.stringify({ version: 1, root, at: now, lanes }), { mode: 0o600 });
      renameSync(tmp, path);
    } catch (error) { log(`health-watch: lane scan cache write failed: ${error.code || 'unknown'}`); }
    finally { try { rmSync(tmp, { force: true }); } catch { /* best-effort temp cleanup */ } }
  }
  return lanes;
}

// Lane-owned config that points git at another worktree, or lets a missing object trigger a lazy fetch that runs a
// lane-chosen transport command (promisor remotes, upload-pack, git proxy). Env pins cannot switch these off on every git.
const LANE_REDIRECT_KEY_RE = /^(core\.(worktree|gitproxy|alternaterefscommand)|extensions\.partialclone|remote\..+\.(promisor|partialclonefilter|uploadpack|vcs))$/is;

/** The local/worktree-scope config keys in {@link LANE_CONFIG_LIST_ARGS} output that redirect the probe or run a transport. Pure. */
export function laneRedirectConfig(listOutput) {
  const parts = String(listOutput ?? '').split('\0');
  const found = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (parts[i] !== 'local' && parts[i] !== 'worktree') continue;
    const key = configKeyCandidates(parts[i + 1]).find(c => LANE_REDIRECT_KEY_RE.test(c));
    if (key !== undefined) found.push(key);
  }
  return found;
}

const LANE_CONFIG_SCOPES = new Set(['system', 'global', 'local', 'worktree', 'command']);

/** True when `listOutput` is a well-formed {@link LANE_CONFIG_LIST_ARGS} listing: empty, or NUL-terminated `scope`/`entry` pairs. */
export function wellFormedConfigList(listOutput) {
  const text = String(listOutput ?? '');
  if (!text) return true;
  const parts = text.split('\0');
  if (parts.pop() !== '' || parts.length % 2) return false;
  return parts.every((part, i) => i % 2 ? part !== '' : LANE_CONFIG_SCOPES.has(part));
}

/** True when `stageOutput` is empty or NUL-terminated `ls-files --stage -z` entries (`mode oid stage<TAB>path`). */
export function wellFormedStageList(stageOutput) {
  const text = String(stageOutput ?? '');
  if (!text) return true;
  const entries = text.split('\0');
  if (entries.pop() !== '') return false;
  return entries.every(entry => /^\d{6} [0-9a-f]{40,64} [0-3]\t[\s\S]+$/.test(entry));
}

// Lane-owned config that changes what status / the index REPORT, so a clean read could sit on top of edits. Each key maps
// to the only value that leaves reporting honest; any other value, or a bare key (which git reads as true), is masking.
// `ls-files -v` tags (h/S) already catch the per-file bits these keys set; this refuses the lane before any probe trusts it.
const BOOL_FALSE = v => /^(false|no|off|0)$/i.test(v);
const BOOL_TRUE = v => /^(true|yes|on|1)$/i.test(v);
const LANE_MASKING_KEYS = Object.freeze([
  [/^core\.(ignorestat|sparsecheckout|sparsecheckoutcone|untrackedcache)$/is, BOOL_FALSE],
  [/^index\.sparse$/is, BOOL_FALSE],
  [/^core\.(filemode|symlinks|trustctime)$/is, BOOL_TRUE],
  [/^core\.autocrlf$/is, BOOL_FALSE],
  [/^core\.eol$/is, v => /^native$/i.test(v)],
  [/^core\.checkstat$/is, v => /^default$/i.test(v)],
]);

/** The local/worktree-scope keys in {@link LANE_CONFIG_LIST_ARGS} output that make status or the index under-report. Pure. */
export function laneMaskingConfig(listOutput) {
  const parts = String(listOutput ?? '').split('\0');
  const found = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (parts[i] !== 'local' && parts[i] !== 'worktree') continue;
    const entry = parts[i + 1];
    const candidates = configKeyCandidates(entry); // once per entry: the entry is lane-writable and may be huge
    for (const [re, honest] of LANE_MASKING_KEYS) {
      const key = candidates.find(c => re.test(c));
      if (key === undefined) continue;
      // A bare key has no `\n<value>` and reads as true.
      const value = entry.length > key.length ? entry.slice(key.length + 1) : 'true';
      if (!honest(value.trim())) found.push(key);
      break;
    }
  }
  return found;
}

// The honest value of every key in LANE_MASKING_KEYS, pinned at command scope for the fresh safety probe. The refusal above
// only sees the lane's own scopes; these pins also beat a host-level (global) `core.fileMode=false` or `core.ignoreStat=true`
// that would hide lane edits from status, and they cannot be undone by anything in the lane.
export const LANE_HONEST_REPORTING_PINS = Object.freeze([
  ['core.ignoreStat', 'false'], ['core.sparseCheckout', 'false'], ['core.sparseCheckoutCone', 'false'], ['index.sparse', 'false'],
  ['core.untrackedCache', 'false'], ['core.fileMode', 'true'], ['core.symlinks', 'true'], ['core.trustctime', 'true'],
  ['core.checkStat', 'default'],
  // core.autocrlf / core.eol are deliberately NOT pinned: they only normalise line endings, so a host that legitimately sets
  // autocrlf=true would read every CRLF checkout as changed and refuse its lanes for good. A lane's OWN value is still refused.
]);

/** `env` with {@link LANE_HONEST_REPORTING_PINS} appended after its existing `GIT_CONFIG_COUNT` entries (the later entry wins). Pure. */
export function withHonestReportingPins(env) {
  const out = { ...env };
  const n = Number.parseInt(String(out.GIT_CONFIG_COUNT ?? '0'), 10);
  const start = Number.isInteger(n) && n > 0 ? n : 0;
  LANE_HONEST_REPORTING_PINS.forEach(([k, v], i) => {
    out[`GIT_CONFIG_KEY_${start + i}`] = k;
    out[`GIT_CONFIG_VALUE_${start + i}`] = v;
  });
  out.GIT_CONFIG_COUNT = String(start + LANE_HONEST_REPORTING_PINS.length);
  return out;
}

/** Env every lane probe git runs under, on top of the repo's lane hardening. */
export function laneProbeEnv(path) {
  // Command-scope parameters outrank the indexed pins, and GIT_CONFIG_GLOBAL/SYSTEM/GIT_CONFIG can re-scope the lane's own
  // keys. Drop every inherited override and location variable before installing our own pins; none is trusted input to a
  // safety probe.
  const env = scrubInheritedGitEnv(laneGitEnv(path));
  return { ...laneGitHardeningEnv(env), GIT_CONFIG_NOSYSTEM: '1', GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1',
    // A lane's refs/replace/* (or a grafts file) can make an unpushed commit read as an already-pushed one.
    GIT_NO_REPLACE_OBJECTS: '1' };
}

/** True when anything (file, symlink, directory) exists at `file`; any error other than "absent" counts as present. */
function graftsFilePresent(file) {
  try { lstatSync(file); return true; } catch (error) { return error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR'; }
}

/**
 * FRESH safety read of ONE lane, right now (never the cache). Unsafe when the worktree has any change (tracked or
 * untracked or ignored), index flags that may hide edits, any stash, or any commit absent from trusted published history. Any git error,
 * timeout or unparseable output is UNSAFE: this answers "may I destroy this lane's state?", so not knowing is no.
 * `readPublishedTips({path})` is a TRUSTED caller capability: synchronously read the intended repository's published
 * commit OIDs from an authenticated remote or daemon-owned authority outside the lane. Bind the repository identity
 * outside the lane too; neither its origin URL, tracking refs, nor cached scan can establish publication. Called on
 * every check; the provider must bound its IO and throw on read errors. No provider is installed by default:
 * an unwired actor refuses, with no local-ref fallback.
 * The caller must hold the lane's exclusive ownership through the check and subsequent action.
 * @returns {{hasUnsafeWork:boolean, fresh:true, observedAt:string, reason:string, error?:string}}
 */
export function freshLaneSafety({ path, exec = execFileSync, now = Date.now, readPublishedTips } = {}) {
  const observedAt = new Date(now()).toISOString();
  const unsafe = (reason, error) => ({ hasUnsafeWork: true, fresh: true, observedAt, reason, ...(error ? { error } : {}) });
  if (typeof path !== 'string' || !path) return unsafe('no lane path');
  const git = argv => String(exec('git', hardenLaneGitArgs(argv), { cwd: path, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
    env: withHonestReportingPins(laneProbeEnv(path)), stdio: ['ignore', 'pipe', 'pipe'] }));
  try {
    // Config reads execute no drivers. Refuse lane-owned filters before status can run a clean filter.
    const config = git([...LANE_CONFIG_LIST_ARGS]);
    // Output we cannot parse is output we cannot trust: a truncated or garbled listing must not read as "no bad keys".
    if (!wellFormedConfigList(config)) return unsafe('lane Git config listing unparseable');
    if (laneFilterDrivers(config).length) return unsafe('lane Git filter drivers present');
    if (laneRedirectConfig(config).length) return unsafe('lane Git config redirects objects, transport or worktree');
    if (laneMaskingConfig(config).length) return unsafe('lane Git config can hide worktree changes');
    // Status can enter submodules with their own untrusted filter config. Do not run that recursive probe.
    const staged = git(['ls-files', '--stage', '-z']);
    if (!wellFormedStageList(staged)) return unsafe('staged index listing unparseable');
    if (staged.split('\0').some(entry => entry.startsWith('160000 '))) {
      return unsafe('submodule safety requires separate inspection');
    }
    // Share destructive cleanup's probe: ignored files and submodule work must remain visible.
    const status = git([...DIRTY_PROBE_ARGS]);
    if (typeof status !== 'string') return unsafe('status unreadable');
    if (status.trim()) return unsafe('worktree has changes');
    if (hasHiddenIndexFlags(git)) return unsafe('index flags may hide worktree changes');
    // `stash list` is `git log -g`: a lane-set log.showSignature + gpg.program must not run a verifier.
    const stash = git(['stash', 'list', '--no-show-signature']);
    if (stash.trim()) return unsafe('stash entries present');
    // A legacy grafts file rewrites parentage (`GIT_NO_REPLACE_OBJECTS` does not switch it off), so it can make unpushed
    // commits read as already pushed. Presence of the file, of any size, is enough: the count below cannot be trusted.
    const grafts = git(['rev-parse', '--git-path', 'info/grafts']).trim();
    if (!grafts) return unsafe('lane grafts path unreadable');
    if (graftsFilePresent(resolve(path, grafts))) return unsafe('lane has legacy grafts file');
    // The lane can forge loose AND packed tracking refs. Only caller-owned publication evidence may exclude
    // commits from the count. Exact object IDs also prevent option/ref-expression injection. The cap bounds argv;
    // an empty/unavailable/oversized authority requires operator inspection, never an origin-ref fallback.
    if (typeof readPublishedTips !== 'function') return unsafe('trusted publication reader required');
    const tips = readPublishedTips({ path });
    if (!Array.isArray(tips) || tips.length === 0 || tips.length > 4096
      || Array.from(tips).some(oid => typeof oid !== 'string' || ![40, 64].includes(oid.length)
        || /[^0-9a-f]/.test(oid))) {
      return unsafe('trusted publication tips unreadable or empty (limit 4096)');
    }
    // Protect work held by other branches, tags or custom refs, plus a detached HEAD. A missing published object
    // makes Git fail (unsafe); do not fetch through lane-owned transport configuration to try to repair it.
    const ahead = git(['rev-list', '--count', '--all', 'HEAD', '--not', ...new Set(tips)]).trim();
    if (!/^\d+$/.test(ahead)) return unsafe('ahead count unreadable');
    if (Number(ahead) > 0) return unsafe(`${ahead} unpushed commit(s)`);
    return { hasUnsafeWork: false, fresh: true, observedAt, reason: 'clean, no stash, nothing unpushed' };
  } catch (error) {
    return unsafe('fresh safety check failed', String(error?.message ?? error).split('\n')[0]);
  }
}

/**
 * THE gate every destructive lane action goes through. Ignores whatever safety a record (cached or not) claims, runs
 * a fresh check of that one lane, and permits `action` only when the fresh result is positively safe. Logged either
 * way. Never throws (a throwing checker is a refusal).
 * @returns {{act:boolean, action:string, path:string, fresh:object, reason:string}}
 */
export function guardLaneAction({ path, action, check = freshLaneSafety, exec, readPublishedTips, log = line => console.error(line) } = {}) {
  let fresh;
  try { fresh = check({ path, ...(exec ? { exec } : {}), readPublishedTips }); }
  catch (error) { fresh = { hasUnsafeWork: true, fresh: true, reason: 'fresh safety check threw', error: String(error?.message ?? error) }; }
  const act = fresh?.fresh === true && fresh.hasUnsafeWork === false;
  const reason = act ? `fresh check safe (${fresh.reason})` : `refused: fresh check ${fresh?.hasUnsafeWork === false ? 'not fresh' : 'unsafe'} (${fresh?.reason ?? 'no result'}${fresh?.error ? `: ${fresh.error}` : ''})`;
  try { log(`health-watch: lane ${action} ${path}: ${reason}`); } catch { /* logging never decides */ }
  return { act, action, path, fresh, reason };
}
