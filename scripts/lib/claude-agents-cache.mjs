import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function claudeAgentsCacheTtlMs(env = process.env) {
  const value = env.WE_CLAUDE_AGENTS_CACHE_TTL_MS;
  if (value === undefined) return env.VITEST ? 0 : 20_000;
  const ttl = Number(value);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : 0;
}

/** Return the raw stdout string; cache failures never replace the caller's fetch result/error. */
export function cachedClaudeAgents({ all = false, fetch, env = process.env, now = Date.now, dir } = {}) {
  const ttl = claudeAgentsCacheTtlMs(env);
  if (!ttl) return String(fetch());
  dir ??= join(tmpdir(), `we-claude-agents-cache-${process.getuid?.() ?? 'unknown'}`);
  const file = join(dir, all ? 'agents-all.json' : 'agents.json');
  try {
    const cached = JSON.parse(readFileSync(file, 'utf8'));
    const time = now();
    if (Number.isFinite(cached.fetchedAt) && cached.fetchedAt <= time && time - cached.fetchedAt < ttl &&
        typeof cached.stdout === 'string' && Array.isArray(JSON.parse(cached.stdout))) return cached.stdout;
  } catch { /* cache miss */ }
  const stdout = String(fetch()); // Fetch errors propagate; never serve stale data.
  let temp;
  try {
    if (!Array.isArray(JSON.parse(stdout))) return stdout;
    const fetchedAt = now();
    mkdirSync(dir, { recursive: true });
    temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(temp, JSON.stringify({ fetchedAt, stdout }), 'utf8');
    renameSync(temp, file);
  } catch { /* best-effort cache */ }
  finally { if (temp) { try { unlinkSync(temp); } catch { /* renamed or unavailable */ } } }
  return stdout;
}
