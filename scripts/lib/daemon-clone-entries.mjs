/** Clone-specific runtime roots. Throws on unreadable/malformed LaunchAgents evidence;
 * callers must retain the full conflict rather than proceed with narrowed entries. */
import { readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DAEMON_ENTRY_MODULES } from './daemon-boot-smoke.mjs';
import { DAEMON_MANIFEST } from '../../skills-src/conveyor/daemon-manifest.mjs';

// Canonicalize both sides of containment, including aliases of a missing entry's
// existing parent. Missing entries still reach closure/smoke's unreadable fallback;
// other filesystem errors must refuse discovery rather than narrow its evidence.
function canonicalArgument(path) {
  const suffix = [];
  for (;;) {
    try { return join(realpathSync(path), ...suffix); }
    catch (error) {
      if (error.code !== 'ENOENT' || dirname(path) === path) throw error;
      suffix.unshift(basename(path));
      path = dirname(path);
    }
  }
}

export function cloneRuntimeEntries({ root, entries = [], env = process.env,
  launchAgentsDir = join(env.HOME || homedir(), 'Library', 'LaunchAgents'), run = spawnSync,
}) {
  const realRoot = realpathSync(root);
  const inside = path => {
    const rel = relative(realRoot, canonicalArgument(path));
    return rel && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel) ? rel : null;
  };
  const out = new Set(DAEMON_ENTRY_MODULES);
  for (const entry of entries) {
    const rel = inside(resolve(realRoot, entry));
    if (!rel) throw new Error('runtime entry outside clone');
    out.add(rel);
  }
  for (const name of readdirSync(launchAgentsDir).sort()) {
    if (!/^com\.(we|plateau|webeverything)\..+\.plist$/.test(name)) continue;
    const result = run('plutil', ['-convert', 'json', '-o', '-', '--', join(launchAgentsDir, name)], {
      encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0) throw new Error(`LaunchAgents plist unreadable: ${name}`);
    const args = JSON.parse(result.stdout).ProgramArguments;
    if (!Array.isArray(args) || !args.length || args.some(arg => typeof arg !== 'string')) {
      throw new Error(`LaunchAgents ProgramArguments invalid: ${name}`);
    }
    for (const arg of args) {
      if (isAbsolute(arg) || arg.startsWith('--pass=')) continue;
      if (/^--(?:import|require|(?:experimental-)?loader)(?:=|$)/.test(arg)
        || arg.includes('/') || /^\.{1,2}$/.test(arg) || /\.[a-z][a-z0-9]*$/i.test(arg)) {
        throw new Error(`LaunchAgents unsupported entrypoint/module argument refused: ${name}: ${arg}`);
      }
    }
    const paths = args.filter(isAbsolute).map(inside).filter(Boolean);
    for (const path of paths) out.add(path);
    if (paths.some(path => basename(path) === 'pass-daemon.mjs')) {
      const passes = args.filter(arg => arg.startsWith('--pass='));
      const pass = passes.length === 1 ? passes[0].slice('--pass='.length) : null;
      const script = Object.hasOwn(DAEMON_MANIFEST, pass) && DAEMON_MANIFEST[pass].script;
      if (!script) throw new Error(`LaunchAgents pass unknown: ${name}`);
      out.add(script);
    }
  }
  return [...out];
}
