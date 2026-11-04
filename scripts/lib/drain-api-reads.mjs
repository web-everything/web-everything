/**
 * @file scripts/lib/drain-api-reads.mjs
 * @description R515/R546 - the drain's git reads that stalled under host load (freeze doc, origin/main backlog
 *   high-water mark, bornAs admission) go through GitHub REST + the ETag reader (a 304 spends no git process).
 *   Setting `drain.reads.source`: "api" (default) | "git" (the old local-git reads). An API failure NEVER falls
 *   back to git: it throws/returns a DrainReadError that is transient (retry next pass) and names its reason.
 */
import { execFileSync } from 'node:child_process';
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

const SLUG_TTL_MS = 60_000;
const slugCache = new Map();
/** `owner/repo` of the checkout's `origin` remote. A parse failure fails closed; GH_REPO must agree or be unset. */
export function readOriginSlug(cwd, { env = process.env, git = (c) => execFileSync('git', ['-C', c, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] }), now = Date.now } = {}) {
  const dir = cwd || process.cwd();
  const hit = slugCache.get(dir);
  let slug = hit && now() - hit.at < SLUG_TTL_MS ? hit.slug : null;
  if (!slug) {
    let url;
    try { url = String(git(dir)).trim(); } catch (e) { throw new DrainReadError('repo-pin', 'origin-unreadable', String(e?.message ?? e).split('\n')[0]); }
    const m = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
    if (!m || m[1] === '.' || m[1] === '..' || m[2] === '.' || m[2] === '..') throw new DrainReadError('repo-pin', 'origin-unparseable', 'origin is not a github.com owner/repo URL');
    slug = `${m[1]}/${m[2]}`;
    slugCache.set(dir, { slug, at: now() });
  }
  const pinned = String(env.GH_REPO ?? '').trim().replace(/^(?:https?:\/\/)?github\.com\//, '');
  if (pinned && pinned.toLowerCase() !== slug.toLowerCase()) throw new DrainReadError('repo-pin', 'repo-mismatch', `GH_REPO ${pinned} is not origin ${slug}`);
  return slug;
}

/** One REST JSON read, pinned to the origin repository; every failure becomes a named transient DrainReadError. */
export function drainRestJson(read, path, { rest = ghRestGetJson, cwd, env = process.env, slug, timeoutMs } = {}) {
  let res;
  try {
    const repo = slug ?? readOriginSlug(cwd, { env });
    const { GH_REPO: _ignored, ...cleanEnv } = env;
    res = rest(String(path).replace('{owner}/{repo}', repo), {
      env: cleanEnv, context: `${repo}@${cwd ?? ''}`,
      execOpts: { ...(cwd ? { cwd } : {}), env: cleanEnv, ...(timeoutMs ? { timeout: timeoutMs } : {}) },
    });
  } catch (e) {
    if (e instanceof DrainReadError) throw e;
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
  // Strict: GitHub wraps lines with \n; nothing else but the base64 alphabet and padding is allowed, and the
  // decode must re-encode to the same text, so corrupt or truncated content can never read as evidence.
  const flat = doc.content.replace(/\n/g, '');
  if (flat.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(flat)) throw new DrainReadError(read, 'api-malformed', 'invalid base64 content');
  const bytes = Buffer.from(flat, 'base64');
  if (bytes.toString('base64') !== flat) throw new DrainReadError(read, 'api-malformed', 'base64 content does not round-trip');
  return bytes.toString('utf8');
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
  const KNOWN = new Set(['added', 'modified', 'removed', 'renamed', 'copied', 'changed', 'unchanged']);
  for (const f of j.files) {
    // Unknown evidence is never skipped: an entry without a name or a known status could hide an added card.
    if (typeof f?.filename !== 'string' || !KNOWN.has(f.status)) throw new DrainReadError(read, 'api-malformed', 'file entry without a name or a known status');
  }
  // A GitHub `renamed` entry is an addition at its NEW path (the old no-rename git diff counted it so); callers filter by prefix.
  return j.files.filter((f) => f.status === 'added' || f.status === 'renamed').map((f) => f.filename);
}
