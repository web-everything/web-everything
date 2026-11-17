/** Pure session-store model. Filesystem and CLI evidence is supplied by the caller. */
import { isDeepStrictEqual } from 'node:util';
import { CREDENTIAL_ENV_VARS, expandConfigDir, isAccountMap, resolveAccount, AccountRefusal } from './claude-account.mjs';

export function storeKey(dir, { home, realpath }) {
  const path = expandConfigDir(dir === undefined || dir === '' ? '~/.claude' : dir, home);
  if (!path) throw new Error('Invalid store selector');
  try {
    const key = expandConfigDir(realpath(path), home);
    if (!key) throw new Error('Invalid canonical store');
    return key;
  } catch (error) {
    // A missing path can still contain symlinks; lexical normalization changes its target.
    if (error?.code === 'ENOENT') return path;
    throw error;
  }
}

const routed = (map, account) => Object.values(map.daemons).includes(account)
  && (account !== 'b' || map.routing?.accountB === true);

export function planStores(options) {
  const { env = {}, map, home, exists } = options;
  const stores = new Map();
  const problems = [];
  function add(dir, account, inherited, isRouted) {
    let key = expandConfigDir(dir || '~/.claude', home);
    let status = 'ok';
    try {
      key = storeKey(dir, options);
      if (!exists(key)) status = 'absent';
    } catch { status = 'unreadable'; }
    if (!key) { problems.push('invalid store selector; repair configuration and retry'); return; }
    if (status === 'absent' && !inherited && !isRouted) return;
    if (status === 'absent') status = 'invalid';
    const previous = stores.get(key);
    const item = { key, account, env: { CLAUDE_CONFIG_DIR: key }, status,
      routed: isRouted, inherited };
    if (previous) {
      item.account ??= previous.account;
      item.routed ||= previous.routed;
      item.inherited ||= previous.inherited;
      if (previous.status !== 'ok') item.status = previous.status;
    }
    stores.set(key, item);
  }
  add(env.CLAUDE_CONFIG_DIR, null, true, false);
  if (!isAccountMap(map)) problems.push('account map unavailable; repair configuration and retry');
  else for (const [account, entry] of Object.entries(map.accounts)) {
    if (Object.hasOwn(entry, 'configDir')) add(entry.configDir, account, false, routed(map, account));
  }
  return { stores: [...stores.values()], problems };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readStore(store, { output, error } = {}) {
  const result = (status, sessions = []) => ({ store, status, sessions });
  if (store.status !== 'ok') return result(store.status);
  if (error !== undefined || output === undefined) return result('unreadable');
  let rows;
  try { rows = typeof output === 'string' ? JSON.parse(output) : output; }
  catch { return result('invalid'); }
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object'
    || typeof row.sessionId !== 'string' || !UUID.test(row.sessionId)
    || (row.id !== undefined && (typeof row.id !== 'string' || !row.id.trim())))) return result('invalid');
  return result('ok', rows.map(row => ({ ...row, sessionId: row.sessionId.toLowerCase(), storeKey: store.key })));
}

/** `planProblems` is planStores().problems: planning gaps (unavailable map) keep the aggregate unknown. */
export function aggregate(reads, { mapAvailable = true, planProblems } = {}) {
  // Required: a caller that forgets planStores().problems must fail loudly, never read as complete discovery.
  if (!Array.isArray(planProblems)) throw new TypeError('aggregate: planProblems (from planStores) is required');
  const rows = new Map();
  const problems = [...planProblems];
  const conflicts = new Set();
  if (!mapAvailable) problems.push('account map unavailable; repair configuration and retry');
  for (const read of reads) {
    if (read.status === 'absent') continue;
    if (read.status !== 'ok') { problems.push(`${read.store.key}: ${read.status}; repair store and retry`); continue; }
    for (const row of read.sessions) {
      const key = JSON.stringify([read.store.key, row.sessionId]);
      if (conflicts.has(key)) continue;
      if (rows.has(key) && !isDeepStrictEqual(rows.get(key), row)) {
        conflicts.add(key);
        rows.delete(key);
        problems.push(`${read.store.key}: conflicting-duplicate-session ${row.sessionId}; repair store and retry`);
      } else rows.set(key, row);
    }
  }
  return { status: problems.length ? 'unknown' : 'ok', rows: [...rows.values()], problems };
}

function normalizedHandle(handle) {
  if (typeof handle !== 'string' || !handle.trim()) throw new Error('Session handle required');
  return handle.trim().toLowerCase();
}

export function resolveOwner(handle, agg) {
  const id = normalizedHandle(handle);
  const matches = agg.rows.filter(row => row.sessionId.startsWith(id)
    || (typeof row.id === 'string' && row.id.trim().toLowerCase() === id));
  if (matches.length > 1) return { kind: 'ambiguous', matches };
  if (matches.length === 1) {
    // Any unreadable store can hold a duplicate of even a full UUID (an ambiguity we cannot see): refuse
    // until discovery is complete, naming the unreadable store(s) in problems.
    if (agg.status !== 'ok') return { kind: 'unknown', problems: agg.problems };
    const row = matches[0];
    return { kind: 'found', store: row.storeKey, row };
  }
  return agg.status === 'ok' ? { kind: 'absent' } : { kind: 'unknown', problems: agg.problems };
}

export function stopPlan(handle, agg) {
  const owner = resolveOwner(handle, agg);
  if (owner.kind === 'absent') return { action: 'gone' };
  if (owner.kind !== 'found') return { action: 'refuse', reason: owner.kind };
  const argId = owner.row.id ?? owner.row.sessionId;
  // The CLI receives this argument in the selected store, so UUID disambiguation must survive that conversion.
  const target = resolveOwner(argId, { status: 'ok', problems: [],
    rows: agg.rows.filter(row => row.storeKey === owner.store) });
  if (target.kind !== 'found') return { action: 'refuse', reason: target.kind };
  return { action: 'stop', storeKey: owner.store, argId,
    env: { CLAUDE_CONFIG_DIR: owner.store } };
}

export function afterStopMiss(handle, key, read) {
  if (read.status !== 'ok' || read.store.key !== key) return { action: 'refuse', reason: 'unknown' };
  const owner = resolveOwner(handle, aggregate([read], { planProblems: [] }));
  return owner.kind === 'absent' ? { action: 'gone' } : { action: 'refuse', reason: 'still-listed' };
}

export function resolveLaunchAccount(options) {
  const { env = {}, map } = options;
  if (!isAccountMap(map)) throw new AccountRefusal('map-unavailable');
  try {
    const selected = resolveAccount(env, map);
    if (selected.kind === 'refuse') throw new AccountRefusal('account-unavailable');
    if (selected.kind !== 'account' || (selected.account === 'b' && map.routing?.accountB !== true)) {
      return { kind: 'inherit', store: storeKey(env.CLAUDE_CONFIG_DIR, options) };
    }
    const entry = map.accounts[selected.account];
    if (!Object.hasOwn(entry, 'configDir')) return { kind: 'account', account: selected.account,
      store: null, env: {}, needsCredential: true };
    const key = storeKey(entry.configDir, options);
    return { kind: 'account', account: selected.account, store: key, env: { CLAUDE_CONFIG_DIR: key } };
  } catch { throw new AccountRefusal('account-unavailable'); }
}

export function applyWorkerEnv(env, launch) {
  if (launch.needsCredential) throw new AccountRefusal('credential-unresolved');
  const next = { ...env };
  if (launch.kind === 'account') {
    // Same scrub as the worker env: never keep the inherited account's credentials next to another store.
    for (const name of CREDENTIAL_ENV_VARS) delete next[name];
    Object.assign(next, launch.env);
  }
  return next;
}

export function trustTargets(stores, launchStore) {
  return { grant: launchStore, revoke: [...new Set(stores.filter(s => s.status !== 'absent').map(s => s.key))] };
}

export function transcriptRoots(stores) {
  // Unreadable stores retain their original selector, including unresolved parent segments.
  return [...new Set(stores.filter(s => s.status !== 'absent').map(s => `${s.key.replace(/\/+$/, '')}/projects`))];
}
