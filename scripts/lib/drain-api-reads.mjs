/**
 * @file scripts/lib/drain-api-reads.mjs
 * @description R515/R546/R551 - the ONE reader for every drain read that stalled under host load (freeze doc, origin/main
 *   backlog high-water mark, bornAs admission). GitHub REST + the ETag reader (a 304 spends no git process), through gh-throttle.
 *   Every result is typed: {ok:true,value,fetchedAt} | {ok:false,reason,detail?,fetchedAt}. Unreadable is never empty, 0 or false;
 *   callers hold (fail closed). R552: the transport is an injectable source `read(kind, key)` so a refresher/snapshot can back it.
 *   Setting `drain.reads.source`: "api" (default) | "git" (the old local-git reads). An API failure NEVER falls
 *   back to git: it throws/returns a DrainReadError that is transient (retry next pass) and names its reason.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  // Hermetic suites stub git; under a test runner the standard default is the old local-git read (an explicit setting still wins).
  const standard = env.VITEST || env.WE_UNDER_TEST ? 'git' : 'api';
  if (file === undefined) { try { file = readSettings(); } catch { file = {}; } }
  if (platform === undefined) { try { platform = platformPreference('drain', { env }); } catch { platform = {}; } }
  const norm = (v) => { const s = String(v ?? '').trim().toLowerCase(); return s === 'api' || s === 'git' ? s : undefined; };
  const c = resolveCascade({
    standard,
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


export const REST_HOST = 'api.github.com';
const DEFAULT_CALL_TIMEOUT_MS = 20_000;
const PINNED_PATH = /^repos\/\{owner\}\/\{repo\}\/[^\s?#]+(?:\?[^\s#]*)?$/;

const unreadable = (reason, now, detail = '') => ({ ok: false, reason, ...(detail ? { detail: String(detail).replace(/\s+/g, ' ').slice(0, 200) } : {}), fetchedAt: now() });

/**
 * The REST transport, pinned to api.github.com (GH_HOST forced, GH_REPO/enterprise token dropped) and to the checkout's
 * origin owner/repo (`repo` optionally names the configured one and must agree). `read('json', path)` takes a
 * `repos/{owner}/{repo}/...` path and returns the typed result; it never throws. Each call has a deadline.
 * @param {{rest?:Function, cwd?:string, env?:object, slug?:string, repo?:string, git?:Function, timeoutMs?:number, deadlineAt?:number, now?:()=>number}} [o]
 */
export function createRestSource({ rest = ghRestGetJson, cwd, env = process.env, slug, repo, git, timeoutMs = DEFAULT_CALL_TIMEOUT_MS, deadlineAt, now = Date.now } = {}) {
  return {
    read(kind, key) {
      if (kind !== 'json') return unreadable('unsupported-kind', now, kind);
      if (typeof key !== 'string' || !PINNED_PATH.test(key) || key.split('?')[0].split('/').some((seg) => seg === '..' || seg === '.') || key.includes('://') || key.includes('//')) return unreadable('path-not-pinned', now, key);
      if (Number.isFinite(deadlineAt) && now() >= deadlineAt) return unreadable('deadline', now, 'overall deadline passed before the call');
      let pinned = slug;
      try {
        pinned ??= readOriginSlug(cwd, { env, ...(git ? { git } : {}) });
        if (repo && String(repo).toLowerCase() !== pinned.toLowerCase()) return unreadable('repo-mismatch', now, `configured ${repo} is not origin ${pinned}`);
      } catch (e) { return unreadable(e?.reason ?? 'repo-pin', now, e?.message); }
      const { GH_REPO: _r, GH_ENTERPRISE_TOKEN: _t, GITHUB_ENTERPRISE_TOKEN: _g, ...base } = env;
      const cleanEnv = { ...base, GH_HOST: 'github.com' };
      let res;
      try {
        res = rest(key.replace('{owner}/{repo}', pinned), {
          env: cleanEnv, context: `${pinned}@${cwd ?? ''}`,
          execOpts: { ...(cwd ? { cwd } : {}), env: cleanEnv, timeout: timeoutMs },
        });
      } catch (e) {
        const text = String(e?.message ?? e).split('\n')[0];
        if (e?.code === 'ETIMEDOUT' || /ETIMEDOUT|timed out/i.test(text)) return unreadable('deadline', now, text);
        return unreadable(e?.httpStatus ? `api-http-${e.httpStatus}` : 'api-error', now, text);
      }
      if (!res || res.json === undefined || res.json === null) return unreadable('api-malformed', now, 'empty response');
      return { ok: true, value: res.json, fetchedAt: now() };
    },
  };
}

/** Run one read through the source and normalize: a throwing or malformed source is unreadable, never a value. */
function pull(read, key, o) {
  const now = o.now ?? Date.now;
  let r;
  try { r = (o.source ?? createRestSource(o)).read('json', key); } catch (e) { return { read, ...unreadable('source-error', now, e?.message) }; }
  if (!r || typeof r.ok !== 'boolean' || (r.ok && !Number.isFinite(r.fetchedAt)) || (!r.ok && typeof r.reason !== 'string')) return { read, ...unreadable('source-malformed', now) };
  return { read, ...r, ...(r.ok ? {} : { fetchedAt: Number.isFinite(r.fetchedAt) ? r.fetchedAt : now() }) };
}
const bad = (r, reason, detail, now = Date.now) => ({ read: r.read, ...unreadable(reason, () => r.fetchedAt ?? now(), detail) });
const good = (r, value) => ({ read: r.read, ok: true, value, fetchedAt: r.fetchedAt });

/** Turn an unreadable typed result into the named transient DrainReadError callers already treat as a hold. */
export function unwrap(result) {
  if (result?.ok === true) return result.value;
  throw new DrainReadError(result?.read ?? 'drain-read', result?.reason ?? 'unreadable', result?.detail);
}

const decode = (r, doc) => {
  const fail = (detail) => bad(r, 'api-malformed', detail);
  if (!doc || typeof doc !== 'object' || doc.type !== 'file' || doc.encoding !== 'base64' || typeof doc.content !== 'string') return fail('not a base64 file response');
  // Strict: GitHub wraps lines with \n; nothing else but the base64 alphabet and padding is allowed, and the
  // decode must re-encode to the same text, so corrupt or truncated content can never read as evidence.
  const flat = doc.content.replace(/\n/g, '');
  if (flat.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(flat)) return fail('invalid base64 content');
  const bytes = Buffer.from(flat, 'base64');
  if (bytes.toString('base64') !== flat) return fail('base64 content does not round-trip');
  // The reported size and git blob sha must both match the decoded bytes (a truncated-but-valid body fails here).
  if (!Number.isInteger(doc.size)) return fail('size missing');
  if (bytes.length !== doc.size) return fail(`size mismatch (${bytes.length} decoded, ${doc.size} reported)`);
  if (typeof doc.sha !== 'string' || !/^[0-9a-f]{40}$/.test(doc.sha)) return fail('sha missing');
  const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (sha !== doc.sha) return fail('sha mismatch');
  return good(r, bytes.toString('utf8'));
};

/** File text at a ref; value null (ok) when the path is absent (404). Malformed/oversized/unverified responses are unreadable. */
export function readFileAtRef(read, path, ref, o = {}) {
  const r = pull(read, `repos/{owner}/{repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`, o);
  if (!r.ok) return r.reason === 'api-http-404' ? { read, ok: true, value: null, fetchedAt: r.fetchedAt } : r;
  return decode(r, r.value);
}

/** Current tip sha of a branch on GitHub. */
export function readBranchSha(branch, o = {}) {
  const r = pull('branch-tip', `repos/{owner}/{repo}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, o);
  if (!r.ok) return r;
  const sha = r.value?.object?.sha;
  return typeof sha === 'string' && /^[0-9a-f]{40,64}$/.test(sha) ? good(r, sha) : bad(r, 'api-malformed', 'no object sha');
}

/** `backlog/<name>` for every entry of main's top-level backlog/ tree (non-recursive: nested paths never carry a card number). */
export function readBacklogNames(branch = 'main', o = {}) {
  const read = 'high-water-mark';
  const root = pull(read, `repos/{owner}/{repo}/git/trees/${encodeURIComponent(branch)}`, o);
  if (!root.ok) return root;
  if (root.value?.truncated === true || !Array.isArray(root.value?.tree)) return bad(root, 'api-malformed', 'root tree unreadable or truncated');
  const entry = root.value.tree.find((t) => t?.path === 'backlog' && t.type === 'tree');
  if (!entry || typeof entry.sha !== 'string' || !/^\w+$/.test(entry.sha)) return bad(root, 'api-malformed', 'no backlog tree in root');
  const dir = pull(read, `repos/{owner}/{repo}/git/trees/${entry.sha}`, o);
  if (!dir.ok) return dir;
  if (dir.value?.truncated === true) return bad(dir, 'api-truncated', 'backlog tree truncated');
  if (!Array.isArray(dir.value?.tree)) return bad(dir, 'api-malformed', 'backlog tree is not a list');
  const names = [];
  for (const t of dir.value.tree) {
    if (typeof t?.path !== 'string') return bad(dir, 'api-malformed', 'tree entry without a path');
    names.push(`backlog/${t.path}`);
  }
  return good(dir, names);
}

const KNOWN_STATUS = new Set(['added', 'modified', 'removed', 'renamed', 'copied', 'changed', 'unchanged']);
const PAGE = 100;
const MAX_PAGES = 30; // GitHub serves at most 3000 compare files; a full last page may hide more, so it is unreadable

/**
 * Files ADDED by headSha relative to base (merge-base compare, like `git diff base...head --diff-filter=A`), following
 * every page. value: { added, previous } - `added` is every added file plus the NEW path of every renamed/copied entry
 * (the old no-rename git diff counted a rename as an addition); `previous` is the old path of renamed/copied entries.
 */
export function readAddedFiles(base, headSha, o = {}) {
  const read = 'bornas-added-files';
  const added = [];
  const previous = [];
  let last;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const r = pull(read, `repos/{owner}/{repo}/compare/${encodeURIComponent(base)}...${headSha}?per_page=${PAGE}&page=${page}`, o);
    if (!r.ok) return r;
    last = r;
    const files = r.value?.files;
    if (!Array.isArray(files)) return bad(r, 'api-malformed', 'no files list');
    for (const f of files) {
      // Unknown evidence is never skipped: an entry without a name or a known status could hide an added card.
      if (typeof f?.filename !== 'string' || !KNOWN_STATUS.has(f.status)) return bad(r, 'api-malformed', 'file entry without a name or a known status');
      if (f.status === 'renamed' || f.status === 'copied') {
        if (typeof f.previous_filename !== 'string') return bad(r, 'api-malformed', `${f.status} entry without previous_filename`);
        previous.push(f.previous_filename);
      }
      if (f.status === 'added' || f.status === 'renamed' || f.status === 'copied') added.push(f.filename);
    }
    if (files.length < PAGE) return good(last, { added, previous });
  }
  return bad(last, 'api-truncated', 'compare file list at the 3000-file ceiling');
}
