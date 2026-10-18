/** Explicit, once-per-lane historical backfill. No routine caller scans transcripts.
 * Cache is permanent and keyed by lane path. Errors/truncation refuse, never cache an unknown as clear.
 * The existing atomic writer and crash-recovering lock keep host state consistent across lane clones.
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeJsonAtomic } from './atomic-json-file.mjs';
import { scanLaneTranscripts } from './lane-transcript-attribution.mjs';
import { hostLoadAdmission, hostSingleFlight, digest } from './host-load.mjs';
import { hostStateRoot, boundedText, loadHostOverloadSettings } from './host-overload-settings.mjs';
export function cachedTranscriptAttribution(root, lanes, { stateRoot = hostStateRoot(), scan = scanLaneTranscripts,
  admission = hostLoadAdmission, log = (m) => process.stderr.write(`${m}\n`), exec, env = process.env } = {}) {
  const policy = loadHostOverloadSettings({ env, log });
  if (!policy.settings.lanes.transcripts.explicitScan) throw Error('explicit transcript scan disabled by policy');
  return hostSingleFlight('transcripts', () => {
    const result = new Map(); const missing = {};
    const cacheDir = join(stateRoot, 'transcripts'); mkdirSync(cacheDir, { recursive: true });
    const cachePath = (path) => join(cacheDir, `${digest(resolve(path))}.json`);
    for (const [key, path] of Object.entries(lanes)) {
      try {
        const saved = JSON.parse(boundedText(cachePath(path), 8 * 1024 * 1024));
        if (saved.lane !== resolve(path) || !validTouches(saved.touches)) throw Error('unknown transcript cache');
        result.set(key, saved.touches);
      } catch (e) { if (e.code !== 'ENOENT') throw e; missing[key] = path; }
    }
    if (Object.keys(missing).length) {
      const host = admission({ policy, env, log });
      if (!host.admitted) throw Error(`transcript scan deferred: ${host.reason}`);
      const scanned = scan(root, missing, { exec, strict: true });
      for (const [key, path] of Object.entries(missing)) {
        const touches = scanned.get(key);
        if (!validTouches(touches)) throw Error('unknown transcript scan result');
        const saved = { lane: resolve(path), touches };
        if (Buffer.byteLength(JSON.stringify(saved)) > 8 * 1024 * 1024) throw Error('transcript cache too large');
        writeJsonAtomic(cachePath(path), saved); result.set(key, touches);
      }
    }
    return result;
  }, { stateRoot });
}

function validTouches(touches) {
  return Array.isArray(touches) && touches.every((t) => t && typeof t.sessionId === 'string'
    && typeof t.tool === 'string' && (t.ts === null || typeof t.ts === 'string')
    && (t.path === null || typeof t.path === 'string'));
}
