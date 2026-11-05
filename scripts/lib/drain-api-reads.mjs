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
import { execFileSyncThrottled } from './gh-throttle.mjs';
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
export function readOriginSlug(cwd, { env = process.env, remote = 'origin', git = (c) => execFileSync('git', ['-C', c, 'remote', 'get-url', remote], { encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }), now = Date.now } = {}) {
  if (!/^[\w.-]+$/.test(String(remote))) throw new DrainReadError('repo-pin', 'origin-unreadable', 'invalid remote name');
  const dir = cwd || process.cwd();
  const key = `${dir}\0${remote}`;
  const hit = slugCache.get(key);
  let slug = hit && now() - hit.at < SLUG_TTL_MS ? hit.slug : null;
  if (!slug) {
    let url;
    try { url = String(git(dir)).trim(); } catch (e) { throw new DrainReadError('repo-pin', 'origin-unreadable', String(e?.message ?? e).split('\n')[0]); }
    const m = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
    if (!m || m[1] === '.' || m[1] === '..' || m[2] === '.' || m[2] === '..') throw new DrainReadError('repo-pin', 'origin-unparseable', 'origin is not a github.com owner/repo URL');
    slug = `${m[1]}/${m[2]}`;
    slugCache.set(key, { slug, at: now() });
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
 * @param {{rest?:Function, cwd?:string, env?:object, slug?:string, repo?:string, remote?:string, git?:Function, timeoutMs?:number, deadlineAt?:number, now?:()=>number}} [o]
 */
// The gh environment of a safety read is built from an ALLOWLIST: token, host, and throttle settings only. Cache, memo, replay
// and binary-override variables (WE_GH_READ_MEMO_DIR, WE_GH_ETAG_*, WE_FINISHED_CI_CACHE_DIR, WE_GH_THROTTLE_GH_BIN, ...) are
// never inherited: a memoized answer has no expiry, so an old unfrozen tip could outlive a published freeze.
const ENV_ALLOW = new Set(['PATH', 'HOME', 'XDG_CONFIG_HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'GH_CONFIG_DIR', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_CALLER',
  'WE_GH_AUTH_TOKEN_HASH', 'WE_GH_AUTH_INSTALLATION', 'WE_GH_AUTH_SOURCE']);
export function pinnedGhEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (v === undefined) continue;
    if (ENV_ALLOW.has(k) || (/^WE_GH_THROTTLE_/.test(k) && k !== 'WE_GH_THROTTLE_GH_BIN')) out[k] = v;
  }
  return { ...out, GH_HOST: 'github.com' };
}

export function createRestSource({ rest, exec = execFileSyncThrottled, cwd, env = process.env, slug, repo, remote = 'origin', git, timeoutMs = DEFAULT_CALL_TIMEOUT_MS, deadlineAt, now = Date.now } = {}) {
  return {
    read(kind, key) {
      if (kind !== 'json') return unreadable('unsupported-kind', now, kind);
      if (typeof key !== 'string' || !PINNED_PATH.test(key) || key.split('?')[0].split('/').some((seg) => seg === '..' || seg === '.') || key.includes('://') || key.includes('//')) return unreadable('path-not-pinned', now, key);
      if (Number.isFinite(deadlineAt) && now() >= deadlineAt) return unreadable('deadline', now, 'overall deadline passed before the call');
      let pinned = slug;
      try {
        pinned ??= readOriginSlug(cwd, { env, remote, ...(git ? { git } : {}) });
        if (repo && String(repo).toLowerCase() !== pinned.toLowerCase()) return unreadable('repo-mismatch', now, `configured ${repo} is not origin ${pinned}`);
      } catch (e) { return unreadable(e?.reason ?? 'repo-pin', now, e?.message); }
      const cleanEnv = pinnedGhEnv(env);
      // gh-throttle's read memo is keyed off throttle.env (default process.env), not the child env: hand it the allowlisted env too.
      const pinnedExec = (file, args, opts = {}) => exec(file, args, { ...opts, throttle: { ...opts.throttle, env: cleanEnv } });
      let res;
      try {
        res = (rest ?? ghRestGetJson)(key.replace('{owner}/{repo}', pinned), {
          ...(rest ? {} : { exec: pinnedExec }),
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


const isCommitSha = (s) => typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);
const FILE_MODES = new Set(['100644', '100755']);

/** Resolve a branch to ONE commit sha (a 40-hex ref is already one). Every multi-part read pins to this sha. */
export function readBranchSha(branch, o = {}) {
  if (isCommitSha(branch)) return { read: 'branch-tip', ok: true, value: branch, fetchedAt: (o.now ?? Date.now)() };
  const r = pull('branch-tip', `repos/{owner}/{repo}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, o);
  if (!r.ok) return r;
  const sha = r.value?.object?.sha;
  return typeof sha === 'string' && /^[0-9a-f]{40,64}$/.test(sha) ? good(r, sha) : bad(r, 'api-malformed', 'no object sha');
}

/** The root tree sha of one commit. */
function readCommitTree(read, commitSha, o) {
  const r = pull(read, `repos/{owner}/{repo}/git/commits/${encodeURIComponent(commitSha)}`, o);
  if (!r.ok) return r;
  const t = r.value?.tree?.sha;
  return typeof t === 'string' && /^\w+$/.test(t) ? good(r, t) : bad(r, 'api-malformed', 'commit without a tree sha');
}

/** One tree's entries; a truncated or malformed tree is unreadable. */
function readTreeEntries(read, treeSha, o) {
  const r = pull(read, `repos/{owner}/{repo}/git/trees/${encodeURIComponent(treeSha)}`, o);
  if (!r.ok) return r;
  if (r.value?.truncated === true) return bad(r, 'api-truncated', 'tree truncated');
  // Completeness must be KNOWN: GitHub always sends a boolean, so anything but a literal false is unreadable.
  if (r.value?.truncated !== false) return bad(r, 'tree-completeness-unknown', `truncated flag is ${JSON.stringify(r.value?.truncated)}`);
  if (!Array.isArray(r.value?.tree)) return bad(r, 'api-malformed', 'tree is not a list');
  for (const t of r.value.tree) if (typeof t?.path !== 'string') return bad(r, 'api-malformed', 'tree entry without a path');
  return good(r, r.value.tree);
}

/**
 * File text at a ref, read at ONE commit sha: the ref resolves to a commit, the path is walked through the commit's trees,
 * and the entry must be a regular blob (mode 100644/100755 - a symlink 120000, a submodule or a tree is unreadable, because
 * the Contents API would follow a symlink). The contents body is fetched at that same sha and its blob sha must equal the
 * tree entry's. value null (ok) when the path is absent. Result carries `sha`, the commit it was read at.
 */
export function readFileAtRef(read, path, ref, o = {}) {
  const tip = readBranchSha(ref, o);
  if (!tip.ok) return { ...tip, read };
  const sha = tip.value;
  const parts = path.split('/');
  let tree = readCommitTree(read, sha, o);
  let entry = null;
  for (let i = 0; i < parts.length; i += 1) {
    if (!tree.ok) return tree;
    const entries = readTreeEntries(read, tree.value, o);
    if (!entries.ok) return entries;
    entry = entries.value.find((t) => t.path === parts[i]) ?? null;
    if (!entry) return { read, ok: true, value: null, sha, fetchedAt: entries.fetchedAt };
    if (i < parts.length - 1) {
      if (entry.type !== 'tree' || typeof entry.sha !== 'string' || !/^\w+$/.test(entry.sha)) return bad(entries, 'api-malformed', `${parts.slice(0, i + 1).join('/')} is not a directory`);
      tree = good(entries, entry.sha);
    } else tree = entries;
  }
  if (entry.type !== 'blob' || !FILE_MODES.has(entry.mode)) return bad(tree, 'api-malformed', `${path} is not a regular file (type ${entry.type}, mode ${entry.mode})`);
  const r = pull(read, `repos/{owner}/{repo}/contents/${parts.map(encodeURIComponent).join('/')}?ref=${sha}`, o);
  if (!r.ok) return r.reason === 'api-http-404' ? bad(r, 'api-malformed', 'tree lists the path but contents is absent') : r;
  if (r.value?.sha !== entry.sha) return bad(r, 'api-malformed', 'contents sha is not the tree entry sha (sha mismatch)');
  const d = decode(r, r.value);
  return d.ok ? { ...d, sha } : d;
}

/**
 * `backlog/<name>` for every entry of the top-level backlog/ tree of ONE commit (non-recursive: nested paths never carry
 * a card number). The branch resolves to a commit sha first; the result carries that `sha`, so a caller needing the tip
 * uses it rather than a second, possibly newer, read.
 */
export function readBacklogNames(branch = 'main', o = {}) {
  const read = 'high-water-mark';
  const tip = readBranchSha(branch, o);
  if (!tip.ok) return { ...tip, read };
  const sha = tip.value;
  const rootSha = readCommitTree(read, sha, o);
  if (!rootSha.ok) return rootSha;
  const root = readTreeEntries(read, rootSha.value, o);
  if (!root.ok) return root;
  const entry = root.value.find((t) => t?.path === 'backlog' && t.type === 'tree');
  if (!entry || typeof entry.sha !== 'string' || !/^\w+$/.test(entry.sha)) return bad(root, 'api-malformed', 'no backlog tree in root');
  const dir = readTreeEntries(read, entry.sha, o);
  if (!dir.ok) return dir;
  return { ...good(dir, dir.value.map((t) => `backlog/${t.path}`)), sha };
}

const KNOWN_STATUS = new Set(['added', 'modified', 'removed', 'renamed', 'copied', 'changed', 'unchanged']);
const COMPARE_CEILING = 300; // GitHub lists at most 300 files per compare, with no truncation flag: 300 or more may hide files

/**
 * Files ADDED by headSha relative to base (merge-base compare, like `git diff base...head --diff-filter=A`).
 * GitHub returns the WHOLE file list (up to 300) on the first response; `page` pages the commits and later pages
 * carry no files, so the files are read from that one response and never paged. value: { added, previous, removed, renames } -
 * `added` is every added file plus the NEW path of every renamed/copied entry (the old no-rename git diff counted a
 * rename as an addition); `previous` is the old path of renamed/copied entries; `removed` is every deleted path;
 * `renames` is each { from, to } of a renamed entry (a copy leaves its source in place, so it is in neither).
 */
export function readAddedFiles(base, headSha, o = {}) {
  const read = 'bornas-added-files';
  // The base resolves to ONE commit sha first, so the comparison is made against exactly the commit the caller can check.
  const baseTip = readBranchSha(base, o);
  if (!baseTip.ok) return { ...baseTip, read };
  const baseSha = baseTip.value;
  const r = pull(read, `repos/{owner}/{repo}/compare/${baseSha}...${headSha}?per_page=100&page=1`, o);
  if (!r.ok) return r;
  const files = r.value?.files;
  if (!Array.isArray(files)) return bad(r, 'api-malformed', 'no files list');
  const added = [];
  const previous = [];
  const removed = [];
  const renames = [];
  for (const f of files) {
    // Unknown evidence is never skipped: an entry without a name or a known status could hide an added card.
    if (typeof f?.filename !== 'string' || !KNOWN_STATUS.has(f.status)) return bad(r, 'api-malformed', 'file entry without a name or a known status');
    if (f.status === 'renamed' || f.status === 'copied') {
      if (typeof f.previous_filename !== 'string') return bad(r, 'api-malformed', `${f.status} entry without previous_filename`);
      previous.push(f.previous_filename);
      if (f.status === 'renamed') renames.push({ from: f.previous_filename, to: f.filename });
    }
    if (f.status === 'removed') removed.push(f.filename);
    if (f.status === 'added' || f.status === 'renamed' || f.status === 'copied') added.push(f.filename);
  }
  if (files.length >= COMPARE_CEILING) return bad(r, 'compare-ceiling', `compare returned ${files.length} files, at the ${COMPARE_CEILING}-file ceiling`);
  return { ...good(r, { added, previous, removed, renames }), baseSha };
}
