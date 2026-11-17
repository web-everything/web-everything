/** Thin IO wrapper over the pure store model (claude-stores.mjs): discover stores, list each, aggregate. */
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { loadAccountMap } from './claude-account.mjs';
import { cachedClaudeAgents } from './claude-agents-cache.mjs';
import { aggregate, planStores, readStore, resolveOwner } from './claude-stores.mjs';

/** Thrown by defaultListAgents when discovery is incomplete; `rows` carries positive evidence; `conflicted` carries possibly-live identities. */
export class SessionsUnknown extends Error {
  constructor(agg) {
    super(`claude sessions unknown: ${agg.problems.join('; ')}`);
    this.name = 'SessionsUnknown';
    this.rows = agg.rows;
    this.conflicted = agg.conflicted ?? [];
    this.problems = agg.problems;
    this.aggregate = agg;
  }
}

function listTimeoutMs(env) {
  const n = Number(env.WE_CLAUDE_LIST_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 30_000;
}

/** @returns {{status:'ok'|'unknown', rows:object[], problems:string[]}} */
export function listSessions({ all = false, fresh = false, env = process.env, exec = execFileSync, map = loadAccountMap(),
  home = env.HOME || homedir(), exists = existsSync, realpath = realpathSync.native ?? realpathSync, cwd, dir } = {}) {
  const plan = planStores({ env, map, home, exists, realpath });
  const single = plan.stores.filter(s => s.status !== 'absent').length <= 1;
  const reads = plan.stores.map(store => {
    if (store.status !== 'ok') return readStore(store);
    try {
      // Preserve the legacy env/cache only for the sole inherited store. A rejected inherited
      // selector can leave one mapped store, which still needs its own CONFIG_DIR and cache key.
      const inherit = single && store.inherited;
      const childEnv = inherit ? env : { ...env, ...store.env };
      const out = cachedClaudeAgents({ all, env: childEnv, fresh, dir, storeKey: inherit ? undefined : store.key,
        fetch: () => exec('claude', ['agents', '--json', ...(all ? ['--all'] : [])], {
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024,
          timeout: listTimeoutMs(env), killSignal: 'SIGKILL', env: childEnv, ...(cwd ? { cwd } : {}) }) });
      return readStore(store, { output: String(out ?? '') } /* empty stdout is invalid, never an empty list */);
    } catch (error) { return readStore(store, { error }); }
  });
  return aggregate(reads, { mapAvailable: map !== null && map !== undefined, planProblems: plan.problems });
}

/** Array when the aggregate is ok; SessionsUnknown (with the positive rows) otherwise, never a silent empty. */
export function defaultListAgents(options = {}) {
  const agg = listSessions(options);
  if (agg.status !== 'ok') throw new SessionsUnknown(agg);
  return agg.rows;
}

/** Owner lookup always reads fresh: an absence claim must not come from a cached listing. */
export function ownerOf(handle, options = {}) {
  // `all` by default: a completed session is still owned by its store, so it must not read as absent.
  return resolveOwner(handle, listSessions({ ...options, all: true, fresh: true }));
}
