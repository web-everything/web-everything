/**
 * @file scripts/lib/drain-api-reads.mjs
 * @description R515/R546 - the drain's git reads that stalled under host load (freeze doc, origin/main backlog
 *   high-water mark, bornAs admission) go through GitHub REST + the ETag reader (a 304 spends no git process).
 *   Setting `drain.reads.source`: "api" (default) | "git" (the old local-git reads). An API failure NEVER falls
 *   back to git: it throws/returns a DrainReadError that is transient (retry next pass) and names its reason.
 */
import { ghRestGetJson } from './gh-rest-read.mjs';
import { readSettings } from './settings-files.mjs';
import { platformPreference, resolveCascade } from './policy-cascade.mjs';

/** Marker carried in every transient read failure message; consumers turn it into a retry note, not a needs-you. */
export const DRAIN_READ_TRANSIENT = 'drain-read-transient';
export const isTransientReadFailure = (text) => String(text ?? '').includes(DRAIN_READ_TRANSIENT);

export class DrainReadError extends Error {
  /** @param {string} reason named reason, e.g. api-http-502, api-malformed, api-truncated */
  constructor(read, reason, detail = '') {
    super(`${DRAIN_READ_TRANSIENT} (${read}: ${reason}) - retries next pass${detail ? `: ${String(detail).replace(/\s+/g, ' ').slice(0, 200)}` : ''}`);
    this.name = 'DrainReadError';
    this.transient = true;
    this.read = read;
    this.reason = reason;
  }
}

export function resolveDrainReadsSource({ env = process.env, file, platform } = {}) {
  if (file === undefined) { try { file = readSettings(); } catch { file = {}; } }
  if (platform === undefined) { try { platform = platformPreference('drain', { env }); } catch { platform = {}; } }
  const norm = (v) => { const s = String(v ?? '').trim().toLowerCase(); return s === 'api' || s === 'git' ? s : undefined; };
  const c = resolveCascade({
    standard: 'api',
    platform: norm(platform?.reads?.source),
    tool: norm(file?.drain?.reads?.source),
    envValues: { '': norm(env.WE_DRAIN_READS_SOURCE) },
    valid: (v) => norm(v) !== undefined,
  });
  return { value: c.value, source: ({ standard: 'default', tool: 'settings' })[c.sources['']] ?? c.sources[''] };
}

/** One REST JSON read; every failure becomes a named transient DrainReadError. Returns the parsed body. */
export function drainRestJson(read, path, { rest = ghRestGetJson, cwd, env = process.env } = {}) {
  let res;
  try { res = rest(path, { env, context: cwd ?? '', execOpts: cwd ? { cwd } : {} }); } catch (e) {
    const status = e?.httpStatus;
    throw new DrainReadError(read, status ? `api-http-${status}` : 'api-error', String(e?.message ?? e).split('\n')[0]);
  }
  if (!res || res.json === undefined || res.json === null) throw new DrainReadError(read, 'api-malformed', 'empty response');
  return res.json;
}

const b64 = (read, doc) => {
  if (!doc || typeof doc !== 'object' || doc.type !== 'file' || doc.encoding !== 'base64' || typeof doc.content !== 'string') {
    throw new DrainReadError(read, 'api-malformed', 'not a base64 file response');
  }
  return Buffer.from(doc.content, 'base64').toString('utf8');
};

/** File text at a ref, or null when the path is absent (404). Malformed/oversized responses fail closed. */
export function readFileAtRef(read, path, ref, o = {}) {
  const url = `repos/{owner}/{repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`;
  try { return b64(read, drainRestJson(read, url, o)); } catch (e) {
    if (e instanceof DrainReadError && e.reason === 'api-http-404') return null;
    throw e;
  }
}

/** Current tip sha of a branch on GitHub. */
export function readBranchSha(branch, o = {}) {
  const j = drainRestJson('branch-tip', `repos/{owner}/{repo}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, o);
  const sha = j?.object?.sha;
  if (typeof sha !== 'string' || !/^[0-9a-f]{40,64}$/.test(sha)) throw new DrainReadError('branch-tip', 'api-malformed', 'no object sha');
  return sha;
}

/** Numeric card ids in main's top-level backlog/ tree (non-recursive: nested paths never carry a card number). */
export function readBacklogNames(branch = 'main', o = {}) {
  const read = 'high-water-mark';
  const root = drainRestJson(read, `repos/{owner}/{repo}/git/trees/${encodeURIComponent(branch)}`, o);
  const entry = Array.isArray(root?.tree) ? root.tree.find((t) => t?.path === 'backlog' && t.type === 'tree') : null;
  if (root?.truncated === true || !Array.isArray(root?.tree)) throw new DrainReadError(read, 'api-malformed', 'root tree unreadable or truncated');
  if (!entry || typeof entry.sha !== 'string') throw new DrainReadError(read, 'api-malformed', 'no backlog tree in root');
  const dir = drainRestJson(read, `repos/{owner}/{repo}/git/trees/${entry.sha}`, o);
  if (dir?.truncated === true) throw new DrainReadError(read, 'api-truncated', 'backlog tree truncated');
  if (!Array.isArray(dir?.tree)) throw new DrainReadError(read, 'api-malformed', 'backlog tree is not a list');
  return dir.tree.map((t) => {
    if (typeof t?.path !== 'string') throw new DrainReadError(read, 'api-malformed', 'tree entry without a path');
    return `backlog/${t.path}`;
  });
}

/** Files ADDED by headSha relative to base (merge-base compare, like `git diff base...head --diff-filter=A`). */
export function readAddedFiles(base, headSha, o = {}) {
  const read = 'bornas-added-files';
  const j = drainRestJson(read, `repos/{owner}/{repo}/compare/${encodeURIComponent(base)}...${headSha}`, o);
  if (!Array.isArray(j?.files)) throw new DrainReadError(read, 'api-malformed', 'no files list');
  // The compare API lists at most 300 files with no truncation flag: a full page may hide more, so fail closed.
  if (j.files.length >= 300) throw new DrainReadError(read, 'api-truncated', 'file list at the 300-file ceiling');
  return j.files.filter((f) => f?.status === 'added').map((f) => {
    if (typeof f.filename !== 'string') throw new DrainReadError(read, 'api-malformed', 'file without a name');
    return f.filename;
  });
}
