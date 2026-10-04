/** Recover committed CI-heal work from lane reflogs before dispatching another agent. */
import { openSync, fstatSync, readSync, closeSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export const CI_HEAL_SALVAGE_ENV = 'WE_CIHEAL_SALVAGE';
export const SALVAGE_REFLOG_TAIL_BYTES_ENV = 'WE_CIHEAL_SALVAGE_REFLOG_BYTES';
const DEFAULT_REFLOG_TAIL_BYTES = 262144;

export function salvageEnabled(env = process.env) {
  return env[CI_HEAL_SALVAGE_ENV] !== '0';
}

/** Pure: reflog order, rather than timestamps, determines recency. */
export function parseReflogSalvageCandidates(text, pr) {
  if (!/^\d+$/.test(String(pr))) return [];
  const messagePattern = new RegExp(`^commit(?: \\(amend\\))?: PR #${pr}: ci-heal\\b`);
  const candidates = new Set();
  for (const line of text.split('\n').reverse()) {
    const tab = line.indexOf('\t');
    if (tab < 0 || !messagePattern.test(line.slice(tab + 1))) continue;
    const sha = line.slice(0, tab).split(/\s+/)[1];
    if (/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sha ?? '')) candidates.add(sha);
  }
  return [...candidates];
}

export function laneDirsForRepo({ poolRoot, poolName, readdir = readdirSync }) {
  try {
    const pool = join(poolRoot, poolName);
    return readdir(pool, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.startsWith('lane-'))
      .map(entry => join(pool, entry.name)).sort();
  } catch { return []; }
}

function readReflogTail(laneDir) {
  let fd;
  try {
    const configured = Number(process.env[SALVAGE_REFLOG_TAIL_BYTES_ENV]);
    const limit = Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_REFLOG_TAIL_BYTES;
    fd = openSync(join(laneDir, '.git', 'logs', 'HEAD'), 'r');
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - limit);
    const buffer = Buffer.alloc(size - start);
    const count = readSync(fd, buffer, 0, buffer.length, start);
    // A truncated first line cannot prove a complete reflog record.
    const text = buffer.subarray(0, count).toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } catch { return ''; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } } }
}

function runGit(dir, args) {
  return spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 60000 });
}

export function findSalvageCommit({ pr, headRefOid, laneDirs, readTail = readReflogTail, git = runGit } = {}) {
  try {
    if (!headRefOid) return null;
    for (const laneDir of laneDirs ?? []) {
      try {
        const candidates = parseReflogSalvageCandidates(readTail(laneDir), pr);
        const qualifying = candidates.filter(sha => sha !== headRefOid
          && git(laneDir, ['cat-file', '-e', `${sha}^{commit}`]).status === 0
          && git(laneDir, ['merge-base', '--is-ancestor', headRefOid, sha]).status === 0);
        // Preserve newest-first preference among unrelated tips, but never choose a tip's ancestor.
        const sha = qualifying.find(candidate => !qualifying.some(other => other !== candidate
          && git(laneDir, ['merge-base', '--is-ancestor', candidate, other]).status === 0));
        if (sha) return { sha, laneDir };
      } catch { /* An unreadable lane must not prevent recovery from another lane. */ }
    }
  } catch { /* Discovery is best effort; normal dispatch remains available. */ }
  return null;
}

export function pushSalvage({ sha, laneDir, headRefName, git = runGit }) {
  try {
    const result = git(laneDir, ['push', 'origin', `${sha}:refs/heads/${headRefName}`]);
    return { ok: result.status === 0,
      detail: String(result.stderr || result.stdout || result.error?.message || `git push exited ${result.status}`).trim() };
  } catch (error) { return { ok: false, detail: String(error.message ?? error) }; }
}
