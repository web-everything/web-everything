/** Injected, read-only IO. Inside a clone only `git rev-parse HEAD` runs; ancestry is resolved in the primary repo. */
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveDaemonClones } from '../lib/daemon-clones.mjs';
import { loadAdoptionMatrixSettingsFile, validateAdoptionMatrixSettings } from '../lib/adoption-matrix-settings.mjs';
import { parseFixReadyLines } from './adoption-matrix.mjs';

export function createAdoptionMatrixReader({
  env = process.env, home = homedir(), cwd = process.cwd(), run = spawnSync, exec = execFileSync,
  readText = path => readFileSync(path, 'utf8'), readdir = readdirSync,
  isDirectory = path => { try { return statSync(path).isDirectory(); } catch { return false; } },
  settings, settingsPath,
} = {}) {
  const config = settings === undefined ? loadAdoptionMatrixSettingsFile(settingsPath, { readText })
    : validateAdoptionMatrixSettings(settings);
  const git = argv => {
    try { return run('git', argv, { cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 }); }
    catch { return null; }
  };
  const tipFor = ref => {
    for (const candidate of [`origin/${ref}`, ref]) {
      const result = git(['rev-parse', '--verify', '--end-of-options', `${candidate}^{commit}`]);
      if (result?.status === 0 && result.stdout?.trim()) return result.stdout.trim();
    }
    return null;
  };
  return ({ branches = '' } = {}) => {
    let fixes;
    if (branches.trim()) {
      fixes = [...new Set(branches.split(',').map(ref => ref.trim()).filter(Boolean))].map(ref => ({ ref }));
    } else {
      const path = env.WE_FIX_READY_PATH || config.fixReadyPath || join(home, 'workspace', '.operations', 'coordination', 'fix-ready.jsonl');
      const expanded = path.startsWith('~/') ? join(home, path.slice(2)) : path;
      let text;
      try { text = readText(expanded); } catch { text = ''; }
      fixes = parseFixReadyLines(text);
    }
    const clones = resolveDaemonClones({ env, home, readdir, exec, clones: config.clones, excludeClones: config.excludeClones });
    const present = clones.map(clone => isDirectory(clone.path));
    const rows = fixes.map(fix => {
      const tipSha = fix.sha || tipFor(fix.ref);
      const cells = clones.map((clone, i) => {
        if (!tipSha || !present[i]) return '?';
        const head = git(['-C', clone.path, 'rev-parse', 'HEAD']);
        const cloneHead = head?.status === 0 ? String(head.stdout ?? '').trim() : '';
        if (!cloneHead) return '?';
        const result = git(['merge-base', '--is-ancestor', tipSha, cloneHead]);
        return result?.status === 0 ? 'yes' : result?.status === 1 ? 'no' : 'unknown (clone-local build)';
      });
      return { ref: fix.ref, tipSha, cells };
    });
    return { clones, rows };
  };
}
