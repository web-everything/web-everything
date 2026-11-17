import { isUnderTest } from './under-test.mjs';
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { storeKey as canonicalStoreKey, readStore } from './claude-stores.mjs';
import { createHash } from 'node:crypto';

export function claudeAgentsCacheTtlMs(env = process.env) {
  const value = env.WE_CLAUDE_AGENTS_CACHE_TTL_MS;
  if (value === undefined) return isUnderTest(env) ? 0 : 20_000;
  const ttl = Number(value);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : 0;
}

/** Return the raw stdout string; cache failures never replace the caller's fetch result/error. */
export function cachedClaudeAgents({ all = false, fetch, env = process.env, now = Date.now, dir, storeKey, fresh = false } = {}) {
  const ttl = claudeAgentsCacheTtlMs(env);
  // `fresh`: destructive paths and absence claims never trust a cached listing.
  if (!ttl || fresh) return String(fetch());
  dir ??= join(tmpdir(), `we-claude-agents-cache-${process.getuid?.() ?? 'unknown'}`);
  const key = storeKey ?? canonicalStoreKey(env.CLAUDE_CONFIG_DIR, {
    home: env.HOME || homedir(), realpath: realpathSync });
  const valid = stdout => readStore({ key, status: 'ok' }, { output: stdout }).status === 'ok';
  // PATH isolates fake executables; identity is the canonical store, independent of selector spelling.
  const parts = [env.PATH ?? '', key];
  const scope = createHash('sha1').update(JSON.stringify(parts))
    .digest('hex').slice(0, 12);
  const file = join(dir, `${all ? 'agents-all' : 'agents'}-${scope}.json`);
  try {
    const cached = JSON.parse(readFileSync(file, 'utf8'));
    const time = now();
    if (Number.isFinite(cached.fetchedAt) && cached.fetchedAt <= time && time - cached.fetchedAt < ttl &&
        typeof cached.stdout === 'string' && valid(cached.stdout)) return cached.stdout;
  } catch { /* cache miss */ }
  const stdout = String(fetch()); // Fetch errors propagate; never serve stale data.
  let temp;
  try {
    if (!valid(stdout)) return stdout;
    const fetchedAt = now();
    mkdirSync(dir, { recursive: true });
    temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(temp, JSON.stringify({ fetchedAt, stdout }), 'utf8');
    renameSync(temp, file);
  } catch { /* best-effort cache */ }
  finally { if (temp) { try { unlinkSync(temp); } catch { /* renamed or unavailable */ } } }
  return stdout;
}
