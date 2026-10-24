/** Shared read-only launchd plist -> clone discovery. No git or launchctl calls. */
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { listDaemonPlistFiles, readPlistAsJson } from '../operations/daemon-status-io.mjs';

export const MAX_DAEMON_CLONES = 20;
const MAX_DISCOVERY_PLISTS = 100;

export function resolveDaemonClones({
  env = process.env, home = homedir(),
  launchAgentsDir,
  readdir = readdirSync, exec = execFileSync, clones = [], excludeClones = [], onIncomplete = () => {},
} = {}) {
  const explicitDiscoveryDir = launchAgentsDir !== undefined || Boolean(env.WE_LAUNCH_AGENTS_DIR);
  launchAgentsDir ??= env.WE_LAUNCH_AGENTS_DIR || join(home, 'Library', 'LaunchAgents');
  const expand = path => resolve(path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path);
  const excluded = new Set(excludeClones.map(expand));
  const byPath = new Map();
  const add = (path, label) => {
    if (typeof path !== 'string' || !path.trim()) return;
    path = expand(path);
    if (excluded.has(path)) return;
    if (!byPath.has(path) && byPath.size >= MAX_DAEMON_CLONES) {
      onIncomplete('clone discovery truncated');
      return;
    }
    if (!byPath.has(path)) byPath.set(path, { path, name: basename(path), labels: [] });
    const labels = byPath.get(path).labels;
    if (label && !labels.includes(label)) labels.push(label);
  };
  const labels = listDaemonPlistFiles(launchAgentsDir, { readdir: dir => {
    try { return readdir(dir); } catch (error) {
      if (error?.code !== 'ENOENT' || explicitDiscoveryDir) onIncomplete('daemon discovery directory unreadable');
      return [];
    }
  } });
  if (labels.length > MAX_DISCOVERY_PLISTS) onIncomplete('daemon plist discovery truncated');
  for (const label of labels.slice(0, MAX_DISCOVERY_PLISTS)) {
    const plist = readPlistAsJson(join(launchAgentsDir, `${label}.plist`), { exec });
    if (!plist) { onIncomplete('daemon plist unreadable'); continue; }
    const clone = label === 'com.plateau.drain-daemon'
      ? plist.EnvironmentVariables?.DRAIN_DAEMON_WE_CLONE : plist.WorkingDirectory;
    if (typeof clone !== 'string' || !clone.trim()) {
      onIncomplete('daemon plist clone field missing or invalid');
      continue;
    }
    add(clone, label);
  }
  for (const path of clones) add(path);
  const result = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  // Keep basename labels short while distinguishing identical basenames in different roots.
  const used = new Set();
  for (const clone of result) {
    const base = clone.name;
    let suffix = 2;
    while (used.has(clone.name)) clone.name = `${base}-${suffix++}`;
    used.add(clone.name);
    clone.labels.sort();
  }
  return result;
}
