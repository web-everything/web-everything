import { mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function buildQueueCacheFile(backlogDir) {
  return join(tmpdir(), `we-build-queue-cache-${process.getuid?.() ?? 'unknown'}`,
    `${createHash('sha1').update(backlogDir).digest('hex')}.json`);
}

/** Stat-only fingerprint; null disables caching when the inputs cannot be inspected. */
export function buildQueueCacheKey({ backlogDir, configPath, next = false }) {
  try {
    const dirMtime = statSync(backlogDir).mtimeMs;
    const files = readdirSync(backlogDir).filter(name => name.endsWith('.md'));
    let maxMtime = 0;
    for (const name of files) maxMtime = Math.max(maxMtime, statSync(join(backlogDir, name)).mtimeMs);
    let configMtime;
    try { configMtime = statSync(configPath).mtimeMs; }
    catch (error) { if (error.code !== 'ENOENT') throw error; configMtime = 'none'; }
    return JSON.stringify([backlogDir, dirMtime, files.length, maxMtime, configMtime, next]);
  } catch { return null; }
}

export function readBuildQueueCache({ file, key, now = Date.now(), maxAgeMs = 60_000 }) {
  try {
    const cached = JSON.parse(readFileSync(file, 'utf8'));
    if (key !== null && cached.key === key && Number.isFinite(cached.at) && cached.at <= now &&
        now - cached.at < maxAgeMs && typeof cached.stdout === 'string') return cached.stdout;
  } catch { /* cache miss */ }
  return null;
}

export function writeBuildQueueCache({ file, key, at = Date.now(), stdout }) {
  if (key === null) return;
  let temp;
  try {
    mkdirSync(dirname(file), { recursive: true });
    temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(temp, JSON.stringify({ key, at, stdout }), 'utf8');
    renameSync(temp, file);
  } catch { /* best-effort cache */ }
  finally { if (temp) { try { unlinkSync(temp); } catch { /* renamed or unavailable */ } } }
}
