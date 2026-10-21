/** Dynamic daemon sources, bounded snapshots, and an append-only Monitor stream. */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { defaultLaunchAgentsDir, listDaemonPlistFiles, readPlistAsJson, extractDaemonSpec, tailFile } from './daemon-status-io.mjs';
import { feedPath } from './needs-you-feed.mjs';
import { alertsFilePath } from '../lib/daemon-rebuild/state.mjs';
import { rotationCountPath } from '../../skills-src/conveyor/daemon-log.mjs';
import { classifyAlertLine } from './alerts.mjs';

/** Reuse daemon-status plist discovery without collecting unrelated git/lease state. */
export function alertSources({ env = process.env, dir = defaultLaunchAgentsDir(env), list = listDaemonPlistFiles,
  read = readPlistAsJson, feedOptions = {} } = {}) {
  const paths = list(dir).flatMap((label) => {
    const plist = read(join(dir, `${label}.plist`)), spec = extractDaemonSpec(label, plist);
    // No exported stderr resolver exists; keep the canonical spec's stdout fallback.
    return [spec.logPath, typeof plist?.StandardErrorPath === 'string' ? plist.StandardErrorPath : null,
      spec.clone ? alertsFilePath(spec.clone, { ...env, ...spec.env }) : null];
  });
  return [...new Set([...paths, feedPath({ ...feedOptions, env })].filter(Boolean))];
}

/** Missing logs are normal; other read failures are surfaced. */
export function collectAlerts({ sources = alertSources(), tail = tailFile, now = () => new Date() } = {}) {
  const lines = sources.flatMap((path) => {
    const result = tail(path, { maxBytes: 512 * 1024 });
    if (result?.error) throw new Error(`${path}: ${result.error}`);
    const text = result?.text ?? '';
    return (result?.truncated ? (text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '') : text).split('\n');
  });
  return { observedAt: now().toISOString(), lines };
}

/** Start at EOF, poll every two seconds, and emit every appended match (up to two seconds of idle latency). */
export async function followAlerts({ sources = alertSources(), onLine = (alert) => process.stdout.write(`${alert.text}\n`),
  excludePrs = [], fileSystem = fs, schedule = setInterval, cancel = clearInterval } = {}) {
  const states = new Map();
  let busy = false, stopped = false;
  const fresh = (stat, rot, offset = 0) => ({ ino: stat.ino, dev: stat.dev, rot, offset, pending: '', decoder: new StringDecoder('utf8') });
  const rotation = async (path) => {
    try { return (await fileSystem.readFile(rotationCountPath(path), 'utf8')).trim(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
  };
  for (const path of sources) {
    try { const stat = await fileSystem.stat(path); states.set(path, fresh(stat, await rotation(path), stat.size)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const poll = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      for (const path of sources) {
        let handle;
        try {
          handle = await fileSystem.open(path, 'r');
          const rot = await rotation(path), stat = await handle.stat();
          let state = states.get(path);
          if (!state || state.ino !== stat.ino || state.dev !== stat.dev || state.rot !== rot || stat.size < state.offset) state = fresh(stat, rot);
          states.set(path, state);
          while (state.offset < stat.size) {
            const buffer = Buffer.alloc(Math.min(64 * 1024, stat.size - state.offset));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, state.offset);
            if (!bytesRead) break;
            state.offset += bytesRead;
            const lines = (state.pending + state.decoder.write(buffer.subarray(0, bytesRead))).split('\n');
            state.pending = lines.pop();
            for (const line of lines) {
              const alert = classifyAlertLine(line.replace(/\r$/, ''), { excludePrs });
              if (!alert) continue;
              onLine(alert);
            }
          }
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          states.delete(path);
        } finally { await handle?.close(); }
      }
    } finally { busy = false; }
  };
  const timer = schedule(() => { poll().catch((error) => { stop(); process.stderr.write(`alerts: ${error.message}\n`); process.exitCode = 1; }); }, 2000);
  const stop = () => { stopped = true; cancel(timer); };
  return { poll, stop };
}
