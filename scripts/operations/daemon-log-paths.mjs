/** Shared discovery for operator explanations and effective-policy observations. */
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { listDaemonPlistFiles, readPlistAsJson, extractDaemonSpec, classifyDaemonSpec } from './daemon-status-io.mjs';
import { resolveCoordinationRoot } from './coordination-root.mjs';

export function discoverDaemonLogPaths({ home = homedir(), coordinationRoot = resolveCoordinationRoot(),
  listFiles = readdirSync, listPlists = listDaemonPlistFiles, readPlist = readPlistAsJson,
  safe = (_source, fn, fallback) => { try { return fn(); } catch { return fallback; } },
} = {}) {
    const workspace = join(home, 'workspace'), reviewRoot = join(workspace, 'wev-review-daemon', '.conveyor');
    const paths = { fix: join(workspace, 'wev-fix-daemon', '.conveyor', 'fix-dispatch-daemon.log'), review: join(reviewRoot, 'review-daemon.log'), drain: join(workspace, 'plateau-app', '.drain-daemon', 'daemon.log'), builder: join(coordinationRoot, 'build-dispatch-daemon.log') };
    const launchDir = join(home, 'Library', 'LaunchAgents');
    for (const label of safe('daemon plists', () => { const entries = listFiles(launchDir); return listPlists(launchDir, { readdir: () => entries }); }, [])) {
      safe(`plist ${label}`, () => {
        const plist = readPlist(join(launchDir, `${label}.plist`)); if (!plist) throw new Error('unreadable plist');
        const spec = extractDaemonSpec(label, plist), family = classifyDaemonSpec(spec);
        const name = spec.programArguments.some(a => a.endsWith('/build-dispatch-daemon.mjs')) ? 'builder' : ({ 'fix-dispatch-daemon': 'fix', 'review-daemon': 'review', 'build-dispatch-daemon': 'builder', 'drain-daemon': 'drain' })[family.kind] ?? (family.kind === 'pass-daemon' ? `pass:${family.pass}` : null);
        if (name && spec.logPath) paths[name] = spec.logPath;
      });
    }
    for (const file of safe('pass logs', () => listFiles(reviewRoot), [])) if (/^pass-daemon\..*\.log$/.test(file)) paths[`pass:${file.slice(12, -4)}`] ??= join(reviewRoot, file);
  return paths;
}
