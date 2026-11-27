/** Coarse, fail-closed smoke evidence. IO ports keep identity/store/coordination independently testable. */
import * as FS from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { hostname, homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { operatorOverridesPath } from '../operator-override-reader.mjs';
import { operatorPreferencesPath } from '../policy-cascade.mjs';
export const RUNNING_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const SHARED_SMOKE_ENV_DELETED = Object.freeze(['WE_DAEMON_CLONE_LOCK_IGNORE_OWNERS', 'WE_DAEMON_REBUILD_READER']);
export const SHARED_SMOKE_ENV_PINNED = Object.freeze({ WE_GH_DAEMON_CALLER: 'rebuild-smoke', XPC_SERVICE_NAME: 'com.we.rebuild-smoke' });
export const SHARED_SMOKE_ENV_LOCATION = Object.freeze(['WE_SMOKE_LIVE_CLONE']);
export const SHARED_SMOKE_ENV_CREDENTIAL = Object.freeze(['GH_TOKEN']);
export const SHARED_SMOKE_FS_EXCLUDED = Object.freeze(['.vite']);
export const SHARED_SMOKE_IGNORED_STATE = Object.freeze(['.conveyor', '.operations', 'node_modules']);
const digest = v => createHash('sha256').update(v).digest('hex'), pack = v => digest(JSON.stringify(v)), hex = (v, n) => typeof v === 'string' && new RegExp(`^[a-f0-9]{${n}}$`).test(v);
const fail = reason => { throw Object.assign(new Error(reason), { reason }); }, inside = (root, p) => { const r = relative(root, p); return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r)); };
const maybe = fn => { try { return fn(); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; } };
const notice = (o, name, data = {}) => { o.alert?.(name, data); o.log?.(`daemon-rebuild: ${name} ${JSON.stringify(data)}`); };
export function sharedRunEnv(env) { const out = { ...env, ...SHARED_SMOKE_ENV_PINNED }; for (const k of SHARED_SMOKE_ENV_DELETED) delete out[k]; return out; }
function gitRead(git, dir, args, env) { const r = git(['-C', dir, ...args], { env }); if (r?.status !== 0 || r.error || r.stdout == null) fail('git-unreadable'); return String(r.stdout); }
function rev(git, dir, value, env) { const s = gitRead(git, dir, ['rev-parse', '--verify', '--end-of-options', value], env).trim(); if (!hex(s, 40)) fail('git-tree-malformed'); return s; }
function nul(s) { if (s && !s.endsWith('\0')) fail('git-list-malformed'); return s ? s.slice(0, -1).split('\0') : []; }
// Index flags and Git's stat cache are hints, never byte evidence. Unknown entry kinds
// (notably symlinks and submodules) deliberately fall back to the ordinary smoke.
function trackedEntries(read, args) {
  return nul(read(args)).map(row => {
    const m = row.match(/^(100644|100755|120000|160000) (?:blob |commit )?([a-f0-9]{40})(?: 0)?\t([\s\S]+)$/);
    if (!m || isAbsolute(m[3]) || m[3].split('/').some(p => !p || p === '..' || p === '.')) fail('tracked-list-malformed');
    return { mode: m[1], oid: m[2], rel: m[3] };
  });
}
function trackedBytes(dir, entry, fs, readFile, kind) {
  if (!['100644', '100755'].includes(entry.mode)) fail(`${kind}-tracked-type: run full smoke; inspect symlinks or submodules`);
  const p = join(dir, entry.rel);
  // Refuse directory symlinks too, including an index entry whose on-disk type changed.
  if (!inside(fs.realpathSync(dir), fs.realpathSync(dirname(p)))) fail(`${kind}-tracked-type`);
  const st = fs.lstatSync(p);
  if (!st.isFile()) fail(`${kind}-tracked-type`);
  const b = readFile(p);
  if (b.length !== st.size) fail('file-changed');
  return { bytes: b, mode: st.mode & 0o111 ? '100755' : '100644' };
}
export function checkoutState(dir, { git, fs = FS, withPath = false, runEnv, check = () => {}, readFile = p => fs.readFileSync(p) } = {}) {
  const read = args => { check(); return gitRead(git, dir, args, runEnv); }, tree = rev(git, dir, 'HEAD^{tree}', runEnv);
  const ignored = nul(read(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']));
  if (ignored.some(p => !SHARED_SMOKE_IGNORED_STATE.includes(p.replace(/\/$/, '')))) fail('harness-ignored');
  const dirty = digest(read(['diff', 'HEAD', '--binary', '--no-ext-diff', '--no-textconv']));
  const tracked = trackedEntries(read, ['ls-files', '--stage', '-z']).map(entry => {
    check();
    // A tracked deletion remains represented by Git's diff; all other unreadable inputs refuse reuse.
    if (!maybe(() => fs.lstatSync(join(dir, entry.rel)))) {
      if (!['100644', '100755'].includes(entry.mode)) fail('harness-tracked-type');
      return [entry.rel, 'absent'];
    }
    const { bytes, mode } = trackedBytes(dir, entry, fs, readFile, 'harness');
    return [entry.rel, mode, digest(bytes)];
  });
  const files = nul(read(['ls-files', '-z', '--others', '--exclude-standard'])).sort().map(rel => {
    check(); if (!rel || isAbsolute(rel) || rel.split('/').includes('..')) fail('harness-untracked-path');
    const p = join(dir, rel), st = fs.lstatSync(p); if (!st.isFile()) fail('harness-untracked-type'); return [rel, st.mode, digest(readFile(p))];
  });
  return withPath ? [fs.realpathSync(dir), tree, dirty, files, tracked] : [tree, dirty, files, tracked];
}
/** null always means run the ordinary smoke; no content, secret or path escapes in diagnostics. */
export function sharedSmokeIdentity(o) {
  const { git, sha, root, candidatePath, runEnv, runningRoot = RUNNING_ROOT, fs = FS, now = Date.now,
    operatorOverrides = operatorOverridesPath, operatorPreferences = operatorPreferencesPath, nodeVersion = process.version, execPath = process.execPath } = o;
  const started = now(), cache = new Map(); let entries = 0, bytes = 0;
  const check = () => { if (!Number.isFinite(started) || now() - started >= 120000) fail('key-timeout: run full smoke; inspect hashing cost'); if (++entries > 500000 || bytes > 8 * 1024 ** 3) fail('key-size-limit: run full smoke; inspect oversized input'); };
  const read = p => { check(); const b = fs.readFileSync(p); bytes += b.length; check(); return b; };
  const stat = p => { check(); return maybe(() => fs.lstatSync(p)); };
  const walk = (dir, kind = 'deps') => {
    const real = fs.realpathSync(dir), h = createHash('sha256');
    const visit = (rel, depth) => {
      check(); if (depth > 128) fail('key-depth-limit: run full smoke; inspect nested input');
      const p = join(real, rel), st = fs.lstatSync(p);
      if (kind === 'snapshot' && rel === '.snapshot-complete') { if (!st.isFile()) fail('harness-unknown'); h.update('P\0.snapshot-complete\0'); }
      else if (kind === 'snapshot' && rel === 'node_modules') { if (!st.isSymbolicLink()) fail('snapshot-deps-mismatch'); h.update(`S\0node_modules\0${deps(fs.realpathSync(p))}\0`); }
      else if (st.isSymbolicLink()) {
        const target = fs.realpathSync(p); if (!inside(real, target) || (kind === 'deps' && SHARED_SMOKE_FS_EXCLUDED.some(x => inside(join(real, x), target)))) fail('deps-symlink-unbound');
        h.update(`L\0${rel}\0${fs.readlinkSync(p)}\0`);
      } else if (st.isDirectory()) {
        h.update(`D\0${rel}\0`); for (const name of fs.readdirSync(p).sort()) if (!(kind === 'deps' && !rel && SHARED_SMOKE_FS_EXCLUDED.includes(name))) visit(rel ? `${rel}/${name}` : name, depth + 1);
      } else if (st.isFile()) { const b = read(p); if (b.length !== st.size) fail('file-changed'); h.update(`F\0${rel}\0${st.mode & 0o111}\0${st.size}\0`); h.update(b); }
      else fail('filesystem-type');
    }; visit('', 0); return h.digest('hex');
  };
  const deps = p => { if (!stat(p)) return 'absent'; const real = fs.realpathSync(p); if (!fs.statSync(real).isDirectory()) fail('deps-not-directory'); if (!cache.has(real)) cache.set(real, walk(real)); return cache.get(real); };
  const snapshotRoot = p => { const m = p.match(/^(.*\/\.snapshots\/code\/[a-f0-9]{40})(?:\/|$)/); return m?.[1]; };
  const state = (dir, withPath = false) => {
    const real = fs.realpathSync(dir); if (stat(join(real, '.git'))) return checkoutState(real, { git, fs, withPath, runEnv, check, readFile: read });
    const snap = snapshotRoot(real); if (snap !== real || !stat(join(real, '.snapshot-complete'))?.isFile()) fail('harness-unknown');
    return ['snapshot', real.split('/').at(-1), walk(real, 'snapshot')];
  };
  const settingsFiles = dir => { if (!stat(dir)) return 'absent'; return walk(dir, 'settings'); };
  const external = p => { const b = maybe(() => read(p)); return b === undefined ? 'absent' : digest(b); };
  const findCheckout = o.findCheckout ?? (p => { let dir = dirname(p); for (let n = 0; n < 128; n++) { check(); if (stat(join(dir, '.git'))) return dir; if (dirname(dir) === dir) return undefined; dir = dirname(dir); } fail('runtime-checkout-depth: run full smoke; inspect target'); });
  const bindTarget = p => {
    const real = fs.realpathSync(p), checkout = findCheckout(real);
    if (checkout) return [state(checkout, true), deps(join(checkout, 'node_modules'))];
    const snap = snapshotRoot(real); if (snap) return state(snap);
    if (/\.(mjs|js|cjs)$/.test(real)) fail('runtime-module-unbound'); return digest(read(real));
  };
  try {
    // Location may be omitted only when the child's reference names the verified owner checkout.
    const liveClone = runEnv.WE_SMOKE_LIVE_CLONE;
    if (typeof liveClone !== 'string' || !isAbsolute(liveClone)
      || fs.realpathSync(liveClone) !== fs.realpathSync(root)) fail('live-clone-mismatch: run full smoke; use the verified root');
    if (!hex(sha, 40)) fail('sha-malformed'); const tree = rev(git, root, `${sha}^{tree}`, runEnv);
    if (rev(git, candidatePath, 'HEAD^{tree}', runEnv) !== tree) fail('candidate-tree-mismatch');
    const status = nul(gitRead(git, candidatePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'], runEnv));
    if (status.some(p => p !== '!! node_modules')) fail('candidate-dirty');
    const candidateRead = args => { check(); return gitRead(git, candidatePath, args, runEnv); };
    const flags = nul(candidateRead(['ls-files', '-v', '-z']));
    if (flags.some(row => !/^H [\s\S]+$/.test(row))) fail('candidate-index-flags: run full smoke; inspect index flags');
    for (const entry of trackedEntries(candidateRead, ['ls-tree', '-r', '-z', '--full-tree', 'HEAD'])) {
      const { bytes: content, mode } = trackedBytes(candidatePath, entry, fs, read, 'candidate');
      const oid = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
      if (mode !== entry.mode || oid !== entry.oid) fail('candidate-bytes-mismatch: run full smoke; inspect candidate files');
    }
    const ownerDeps = join(root, 'node_modules'), candidateDeps = join(candidatePath, 'node_modules'), a = stat(ownerDeps), b = stat(candidateDeps);
    if (a || b) { if (!a || !b?.isSymbolicLink() || fs.realpathSync(ownerDeps) !== fs.realpathSync(candidateDeps)) fail('candidate-deps-mismatch'); }
    const harness = pack(state(runningRoot)), nodeModules = pack([deps(ownerDeps), ...(fs.realpathSync(root) === fs.realpathSync(runningRoot) ? [] : [deps(join(runningRoot, 'node_modules'))])]);
    const refresh = o.refresh, minted = refresh?.applied === true && refresh.before && refresh.after && refresh.before.GH_TOKEN !== refresh.after.GH_TOKEN && refresh.after.GH_TOKEN === runEnv.GH_TOKEN;
    const env = pack(Object.keys(runEnv).sort().filter(k => !SHARED_SMOKE_ENV_LOCATION.includes(k) && !(minted && SHARED_SMOKE_ENV_CREDENTIAL.includes(k))).map(k => {
      check(); const v = runEnv[k]; if (typeof v !== 'string') fail('env-value-invalid'); let file = '';
      if (isAbsolute(v)) { const st = maybe(() => fs.statSync(v)); if (st?.isFile()) { if (st.size > 4 * 1024 ** 2) fail('env-file-oversized: run full smoke; inspect input file'); file = digest(read(v)); } }
      return [k, v, file];
    }));
    const files = pack([settingsFiles(join(candidatePath, 'scripts/settings')), settingsFiles(join(runningRoot, 'scripts/settings')), external(operatorOverrides()), external(operatorPreferences(runEnv))]);
    const path = runEnv.PATH?.split(':'); if (!path?.length || path.some(p => !isAbsolute(p))) fail('runtime-path-relative');
    const runtimes = ['node', 'git', 'gh'].map(name => {
      let found;
      for (const dir of path) { check(); const p = join(dir, name), st = maybe(() => fs.statSync(p)); if (!st || !st.isFile() || !(st.mode & 0o111)) continue; try { fs.accessSync(p, FS.constants.X_OK); } catch (e) { if (e.code === 'EACCES') continue; throw e; } found = [dir, fs.realpathSync(p)]; break; }
      if (!found) fail('runtime-missing'); const b = read(found[1]), bound = [name, ...found, digest(b)];
      if (b.subarray(0, 2).toString() === '#!') {
        const text = b.toString(); if (name !== 'gh' || !text.includes('// AUTO-GENERATED by')) fail('runtime-script'); const targets = new Map();
        for (const line of text.split('\n')) {
          if (!/^const [A-Z_]+ = "\//.test(line)) continue;
          const m = line.match(/^const ([A-Z_]+) = ("(?:[^"\\]|\\.)*");?$/); if (!m || targets.has(m[1])) fail('runtime-shim-layout');
          let p; try { p = JSON.parse(m[2]); } catch { fail('runtime-shim-layout'); } if (!isAbsolute(p)) fail('runtime-shim-layout'); targets.set(m[1], p);
        }
        if (['GH_THROTTLE_CLI', 'REAL_GH_THROTTLE_CLI', 'APP_REFRESH_CLI'].some(k => !targets.has(k))) fail('runtime-shim-layout');
        bound.push([...targets].filter(([k]) => k !== 'CACHE_PATH').sort().map(([k, p]) => [k, bindTarget(p)]));
      }
      if (name === 'git') bound.push(gitRead(git, root, ['--version'], runEnv)); return bound;
    });
    const runtime = pack([nodeVersion, digest(read(fs.realpathSync(execPath))), runtimes]), components = { tree: digest(tree), harness, nodeModules, env, files, runtime }; check();
    return { key: pack(['smoke-shared/1', tree, harness, nodeModules, env, files, runtime]), sha, tree, components };
  } catch (e) { notice(o, 'smoke-shared-off', { reason: e.reason ?? 'identity-unreadable: run full smoke; inspect inputs' }); return null; }
}
const validIdentity = i => i && hex(i.key, 64) && hex(i.sha, 40) && hex(i.tree, 40) && Object.keys(i.components ?? {}).length === 6 && ['tree', 'harness', 'nodeModules', 'env', 'files', 'runtime'].every(k => hex(i.components?.[k], 64)) && i.components.tree === digest(i.tree) && i.key === pack(['smoke-shared/1', i.tree, ...['harness', 'nodeModules', 'env', 'files', 'runtime'].map(k => i.components[k])]);
const storeDir = o => join(o.stateDir ?? o.env?.WE_DAEMON_SMOKE_STATE_DIR ?? join(homedir(), '.claude/daemon-self-sync-state'), 'smoke-shared');
/** The caller supplies live tree resolution; unavailable evidence is always a miss. */
export function readSharedPass(o) {
  try {
    const { identity: i, fs = FS, now = Date.now, passTtlMs, reuseHours, treeOf } = o; if (!validIdentity(i) || !Number.isFinite(passTtlMs) || !Number.isFinite(reuseHours)) return null;
    const p = join(storeDir(o), `${i.key}.pass.json`), st = fs.lstatSync(p); if (!st.isFile() || st.size > 65536) return null;
    const r = JSON.parse(fs.readFileSync(p, 'utf8')), age = now() - Date.parse(r.passedAt);
    return r.schema === 1 && r.key === i.key && hex(r.sha, 40) && r.tree === i.tree && treeOf(r.sha) === r.tree && validIdentity(r)
      && JSON.stringify(r.components) === JSON.stringify(i.components) && Number.isFinite(age) && age >= 0 && age < Math.min(passTtlMs, reuseHours * 3600000) ? r : null;
  } catch (e) { if (e.code !== 'ENOENT') notice(o, 'smoke-shared-store-miss', { reason: 'record-unreadable-or-invalid' }); return null; }
}
function atomic(fs, p, value, sync = false) {
  const tmp = join(dirname(p), `.${p.split(sep).at(-1)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`); let fd;
  try { fd = fs.openSync(tmp, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify(value)); if (sync) fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; fs.renameSync(tmp, p); if (sync) { fd = fs.openSync(dirname(p), 'r'); fs.fsyncSync(fd); } }
  finally { if (fd !== undefined) fs.closeSync(fd); maybe(() => fs.unlinkSync(tmp)); }
}
export function publishSharedPass(o) {
  const { fs = FS, identity: i, result, canPublish, now = Date.now } = o;
  if (!validIdentity(i) || !canPublish || result?.verdict !== 'pass' || result.disabled || result.cached || canPublish(result) !== true) return false;
  try {
    const dir = storeDir(o); fs.mkdirSync(dir, { recursive: true });
    const r = { schema: 1, key: i.key, sha: i.sha, tree: i.tree, passedAt: new Date(now()).toISOString(), components: i.components,
      leader: { host: o.host ?? hostname(), pid: o.pid ?? process.pid, stateKey: o.stateKey }, timings: o.timings ?? { ms: 0, reconcileMs: 0, dispatchMs: 0 } };
    atomic(fs, join(dir, `${i.key}.pass.json`), r, true); notice(o, 'smoke-shared-published', { key: i.key });
    try { const names = fs.readdirSync(dir); if (names.length > 10000) notice(o, 'smoke-shared-prune-deferred', { reason: 'entry-limit; operator should prune aged records' });
      for (const name of names.slice(0, 10000)) { const p = join(dir, name), st = maybe(() => fs.lstatSync(p)); if (!st) continue; const age = now() - st.mtimeMs;
        if ((/^[a-f0-9]{64}\.pass\.json$/.test(name) && age >= 86400000) || ((name.endsWith('.tmp') || /^[a-f0-9]{64}\.lock\.stale-[a-f0-9]{8}$/.test(name)) && age >= 3600000)) maybe(() => fs.rmSync(p, { recursive: true })); }
    } catch { notice(o, 'smoke-shared-prune-deferred', { reason: 'prune-unreadable; operator should inspect store' }); }
    return true;
  } catch (e) { notice(o, 'smoke-shared-store-error', { reason: 'publish-or-prune-failed: run full smoke; inspect store permissions and disk' }); return false; }
}
const ranges = { passTtlMs: [0, 86400000], followerMaxWaitMs: [0, 86400000], followerPollMs: [1000, 60000], ownRunMinMs: [0, 3000000], leaderHeartbeatMs: [1000, 300000], leaderStaleMs: [10000, 3600000] };
function eligibility(o, fs) {
  const s = o.settings, env = o.env; if (env?.WE_REBUILD_SMOKE_SHARED === '0' || s?.enabled === false) return 'disabled';
  if (!s || typeof s.enabled !== 'boolean' || Object.entries(ranges).some(([k, [a, b]]) => !Number.isInteger(s[k]) || s[k] < a || s[k] > b) || s.leaderHeartbeatMs * 3 > s.leaderStaleMs) return 'settings-invalid';
  if (o.reuseEnabled !== true || o.gateEnabled !== true || o.label != null || o.changedFiles !== null || env?.WE_DAEMON_MANAGED_CLONE !== '1') return 'ineligible';
  if (!Number.isFinite(o.deadline) || !Number.isFinite(o.reuseHours) || o.reuseHours < 0) return 'budget-or-reuse-unknown';
  try { const root = fs.realpathSync(o.root); if (!env.LANE_POOL_ROOT) return 'lane-root-unknown'; if (root.split(sep).some(x => /^lane-\d+$/.test(x)) || inside(fs.realpathSync(env.LANE_POOL_ROOT), root)) return 'lane'; } catch { return 'root-unreadable'; }
  return null;
}
/** run receives {reuseCode, role}; canPublish is S2's complete local-write predicate, never a default approval.
 * runEnvironment, when provided, must be the ordinary smoke runner with code-only reuse;
 * its full current result (including every environment refusal) is returned on cache hits.
 * Omitting that port runs full smoke even on a hit.
 */
export async function sharedSmoke(o) {
  const { fs = FS, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), host = hostname(), pid = process.pid, settings: s } = o;
  const started = now(), reason = eligibility(o, fs), announce = (role, i, extra = {}) => { const data = { role, key: i?.key, components: i?.components, waitedMs: now() - started, ...extra }; o.log?.(`daemon-rebuild: smoke-shared ${JSON.stringify(data)}`); return data; };
  if (reason) { notice(o, 'smoke-shared-off', { reason }); return { ...announce('off'), reason, result: await o.run({ role: 'off', reuseCode: false }), published: false }; }
  const fresh = () => { try { return typeof o.identity === 'function' ? o.identity() : fail('identity-recompute-required'); } catch { notice(o, 'smoke-shared-off', { reason: 'identity-unreadable; run full smoke' }); return null; } }; let i = fresh();
  if (!validIdentity(i)) { notice(o, 'smoke-shared-off', { reason: 'identity-unavailable' }); return { ...announce('off'), reason: 'identity-unavailable', result: await o.run({ role: 'off', reuseCode: false }), published: false }; }
  let lock, token, timer, role = 'own', storeError = false; const opts = () => ({ ...o, fs, now, host, pid, identity: i, passTtlMs: s.passTtlMs, reuseHours: o.reuseHours ?? 12 });
  const ownerAt = path => { try { return JSON.parse(fs.readFileSync(join(path, 'owner.json'), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return undefined; notice(o, 'smoke-shared-lock-held', { reason: 'owner-unreadable; wait bounded then run own' }); return null; } };
  // Every cooperating acquisition, reclamation, heartbeat and release holds this mutex.
  // Never steal it by age: a crashed mutation forces bounded own-smoke fallback until
  // an operator verifies no writer remains and removes the abandoned .guard directory.
  const guarded = action => {
    const guard = `${lock}.guard`;
    try { fs.mkdirSync(guard); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      notice(o, 'smoke-shared-lock-held', { reason: 'mutation-held; run own at bound; operator may inspect abandoned guard' });
      return false;
    }
    try { return action(); } finally { fs.rmdirSync(guard); }
  };
  const observation = path => {
    const st = fs.lstatSync(path);
    if (!st.isDirectory() || st.isSymbolicLink()) fail('lock-type');
    return { dev: st.dev, ino: st.ino, owner: ownerAt(path) };
  };
  const sameOwner = (a, b) => a.dev === b.dev && a.ino === b.ino && a.owner !== null && b.owner !== null
    && JSON.stringify(a.owner) === JSON.stringify(b.owner);
  // Move first, then verify the actual moved directory before mutating it. A replacement
  // at the rename boundary is restored intact while still holding the mutation mutex.
  const mutateObserved = (observed, action) => {
    const moved = `${lock}.stale-${randomBytes(4).toString('hex')}`;
    if (!sameOwner(observed, observation(lock))) return false;
    fs.renameSync(lock, moved);
    let restore = true;
    try {
      if (!sameOwner(observed, observation(moved))) return false;
      action(moved); restore = false; return true;
    } finally {
      if (restore) {
        if (maybe(() => fs.lstatSync(lock))) fail('lock-restore-conflict: operator must inspect quarantined owner');
        fs.renameSync(moved, lock);
      }
    }
  };
  const release = () => { try { guarded(() => {
    const observed = observation(lock);
    if (observed.owner?.token === token) mutateObserved(observed, moved => fs.rmSync(moved, { recursive: true }));
  }); } catch { notice(o, 'smoke-shared-store-error', { reason: 'release-failed; inspect lock or await stale reclaim' }); } };
  const useHit = async hit => {
    // The environment runner must run the ordinary smoke with code-only reuse. Without
    // that explicit port, run every check. Never synthesize a pass from the stored row.
    const result = typeof o.runEnvironment === 'function'
      ? await o.runEnvironment({ role: 'follower', reuseCode: true })
      : await o.run({ role: 'follower', reuseCode: false });
    notice(o, 'smoke-shared-hit', { passedAt: hit.passedAt, timings: hit.timings });
    return { ...announce('follower', i), hit: true, record: hit, result, published: false };
  };
  const until = started + Math.max(0, Math.min(s.followerMaxWaitMs, o.deadline - started - s.ownRunMinMs));
  try {
    for (let polls = 0; polls <= Math.ceil(s.followerMaxWaitMs / s.followerPollMs) + 2; polls++) {
      const current = fresh(); if (!validIdentity(current) || current.key !== i.key) { notice(o, 'smoke-shared-inputs-changed', { names: [] }); break; }
      i = current; const hit = readSharedPass(opts()); if (hit) return useHit(hit);
      lock = join(storeDir(o), `${i.key}.lock`); const prepared = `${lock}.${randomBytes(4).toString('hex')}.tmp`; token = randomBytes(16).toString('hex');
      try {
        fs.mkdirSync(prepared, { recursive: true }); fs.writeFileSync(join(prepared, 'owner.json'), JSON.stringify({ token, host, pid, stateKey: o.stateKey, startedAt: now(), heartbeatAt: now() }));
        guarded(() => {
          if (!maybe(() => fs.lstatSync(lock))) { fs.renameSync(prepared, lock); role = 'leader'; return; }
          const observed = observation(lock), own = observed.owner, st = fs.lstatSync(lock);
          let stale = own === undefined && now() - st.mtimeMs >= 60000;
          if (own && typeof own.token === 'string' && typeof own.host === 'string' && Number.isInteger(own.pid) && own.pid > 0 && Number.isFinite(own.heartbeatAt) && own.heartbeatAt <= now()) {
            stale = now() - own.heartbeatAt >= s.leaderStaleMs;
            if (!stale && own.host === host) {
              try { stale = (o.pidAlive ?? (p => { try { process.kill(p, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } }))(own.pid) === false; }
              catch { notice(o, 'smoke-shared-lock-held', { reason: 'pid-unknown; wait bounded then run own' }); }
            }
          }
          if (stale && mutateObserved(observed, moved => fs.rmSync(moved, { recursive: true }))) {
            fs.renameSync(prepared, lock); role = 'leader';
          }
        });
      } finally { fs.rmSync(prepared, { recursive: true, force: true }); }
      if (role === 'leader') { const hit = readSharedPass({ ...opts(), identity: fresh() }); if (hit) { release(); return useHit(hit); } break; }
      if (now() >= until) break; await sleep(Math.min(s.followerPollMs, until - now()));
    }
  } catch { storeError = true; notice(o, 'smoke-shared-store-error', { reason: 'coordination-unreadable: run full smoke; inspect store' }); }
  const data = announce(role, i); notice(o, role === 'leader' ? 'smoke-shared-lead' : 'smoke-shared-wait-timeout', { key: i.key });
  if (role === 'leader') { timer = setInterval(() => { try {
    guarded(() => {
      const observed = observation(lock);
      if (observed.owner?.token !== token) { clearInterval(timer); return; }
      if (!mutateObserved(observed, moved => {
        atomic(fs, join(moved, 'owner.json'), { ...observed.owner, heartbeatAt: now() });
        fs.renameSync(moved, lock);
      })) clearInterval(timer);
    });
  } catch { clearInterval(timer); notice(o, 'smoke-shared-store-error', { reason: 'heartbeat-failed; follower may run own' }); } }, s.leaderHeartbeatMs); timer.unref?.(); }
  try {
    const result = await o.run({ role, reuseCode: false }), after = fresh(), drift = !validIdentity(after) || after.key !== i.key;
    if (drift) notice(o, 'smoke-shared-inputs-changed', { names: [] });
    const ms = now() - started, rowMs = name => result?.smoke?.results?.find(r => r.name === name)?.ms ?? 0;
    return { ...data, hit: false, result, published: !storeError && !drift && publishSharedPass({ ...opts(), result, timings: { ms, reconcileMs: rowMs('reconcile-dry-run'), dispatchMs: rowMs('dispatch-dry-run') } }) };
  } finally { if (timer) clearInterval(timer); if (role === 'leader') release(); }
}
