/** Injected, read-only IO. Object presence and ancestry failures remain distinct. */
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveDaemonClones } from '../lib/daemon-clones.mjs';
import { loadAdoptionMatrixSettingsFile, validateAdoptionMatrixSettings } from '../lib/adoption-matrix-settings.mjs';
import { parseFixReadyLines, MAX_ADOPTION_REFS } from './adoption-matrix.mjs';

export const MAX_ADOPTION_PROBES = 500;
const MAX_LOG_BYTES = 1024 * 1024;

function readLogTail(path) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - MAX_LOG_BYTES);
    const bytes = Buffer.alloc(Math.min(size, MAX_LOG_BYTES));
    const count = readSync(fd, bytes, 0, bytes.length, start);
    if (count !== bytes.length) throw new Error('short log read');
    const text = bytes.toString('utf8');
    return { text: start ? (text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '') : text, truncated: start > 0 };
  } finally { closeSync(fd); }
}

const SHA = /^[a-f0-9]{7,40}$/i;

export function createAdoptionMatrixReader({
  env = process.env, home = homedir(), cwd = process.cwd(), run = spawnSync, exec = execFileSync,
  readText, readdir = readdirSync,
  isDirectory = path => { try { return statSync(path).isDirectory(); } catch { return false; } },
  settings, settingsPath,
} = {}) {
  const config = settings === undefined ? loadAdoptionMatrixSettingsFile(settingsPath, { readText: readText ?? (path => readFileSync(path, 'utf8')) })
    : validateAdoptionMatrixSettings(settings);
  let probes, truncated;
  const git = argv => {
    if (probes >= MAX_ADOPTION_PROBES) { truncated = true; return null; }
    probes++;
    try { return run('git', argv, { cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 }); }
    catch { return null; }
  };
  const tipFor = ref => {
    for (const candidate of [`origin/${ref}`, ref]) {
      const result = git(['rev-parse', '--verify', '--end-of-options', `${candidate}^{commit}`]);
      if (result?.status === 0 && SHA.test(result.stdout?.trim() ?? '')) return result.stdout.trim();
    }
    return null;
  };
  return ({ branches = '' } = {}) => {
    probes = 0;
    truncated = false;
    const incomplete = [];
    const note = reason => {
      if (!incomplete.includes(reason)) incomplete.push(reason);
      if (reason.includes('truncated')) truncated = true;
    };
    let fixes;
    if (branches.trim()) {
      fixes = [...new Set(branches.split(',').map(ref => ref.trim()).filter(Boolean))].map(ref => ({ ref }));
    } else {
      const path = env.WE_FIX_READY_PATH || config.fixReadyPath || join(home, 'workspace', '.operations', 'coordination', 'fix-ready.jsonl');
      const expanded = path.startsWith('~/') ? join(home, path.slice(2)) : path;
      let text;
      try {
        const log = readText ? { text: String(readText(expanded)) } : readLogTail(expanded);
        truncated ||= log.truncated === true || log.text.length > MAX_LOG_BYTES;
        text = log.text.slice(-MAX_LOG_BYTES);
      } catch (error) {
        if (error?.code !== 'ENOENT' || env.WE_FIX_READY_PATH || config.fixReadyPath) note('fix-ready log unreadable');
        text = '';
      }
      fixes = parseFixReadyLines(text, { onTruncated: () => { truncated = true; } });
      fixes.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
    }
    if (fixes.length > MAX_ADOPTION_REFS) {
      fixes = fixes.slice(-MAX_ADOPTION_REFS);
      truncated = true;
    }
    const clones = resolveDaemonClones({ env, home, readdir, exec, clones: config.clones, excludeClones: config.excludeClones, onIncomplete: note });
    const present = clones.map(clone => isDirectory(clone.path));
    const rows = fixes.map(fix => {
      // Logged revisions must be immutable SHAs; never reinterpret invalid/missing log data as a ref.
      const tipSha = Object.hasOwn(fix, 'sha') ? (SHA.test(fix.sha) ? fix.sha : null) : tipFor(fix.ref);
      const cells = clones.map((clone, i) => {
        if (!tipSha || !present[i]) return '?';
        const object = git(['-C', clone.path, 'cat-file', '-e', `${tipSha}^{commit}`]);
        if (object?.status === 1) return 'no (not in clone)';
        if (object?.status === 128 && String(object.stderr ?? '').trim()
          === `fatal: Not a valid object name ${tipSha}^{commit}`) return 'no (not in clone)';
        if (object?.status !== 0) return '?';
        const result = git(['-C', clone.path, 'merge-base', '--is-ancestor', tipSha, 'HEAD']);
        return result?.status === 0 ? 'yes' : result?.status === 1 ? 'no' : '?';
      });
      return { ref: fix.ref, tipSha, cells };
    });
    return { clones, rows, ...(incomplete.length ? { incomplete } : {}), ...(truncated ? { truncated: true } : {}) };
  };
}
