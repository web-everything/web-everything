/** S1a / DPOL-HCA-002: read-only App permissions and applicable ruleset authority.
 * Audit files never grant admission: admissionCheck collects and decides in memory.
 * Identity probes, local credentials, classic protection and deploy keys are later slices.
 */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as childProcess from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { platform } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const S1A_OPERATOR = 'chalbert';
export const ORGS = Object.freeze(['web-everything', 'plateauapp', 'frontier-ui', 'longshoreai']);
export const SECRET_RE = /gh[opsur]_[A-Za-z0-9]{8,}|github_pat_|-{5}BEGIN|x-access-token|[Aa]uthorization:|[Bb]earer /;
const SCHEMA = 'hca-inventory/1';
const FATALS = ['READER-NOT-OPERATOR', 'READER-SCOPE', 'AUTH-FAILED', 'SECRET-DETECTED', 'SELF-SCHEMA'];
const REASONS = ['UNREAD', 'RATE-LIMITED', 'MALFORMED', 'REDACTED-FIELD', 'UNKNOWN', 'UNSTABLE', 'ORG-UNLISTED', 'COHORT'];
const ACTORS = ['Integration', 'RepositoryRole', 'Team', 'OrganizationAdmin', 'DeployKey'];
const MODES = ['always', 'pull_request', 'exempt'];
const LEVELS = ['read', 'write', 'admin'];
const TYPES = ['Repository', 'Organization', 'Enterprise'];
const SCOPES = ['repo', 'admin:org', 'read:org'];
const RUN_RE = /^[0-9]{8}T[0-9]{6}-[0-9a-f]{8}$/;
const TIME_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(-04:00|-05:00)$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const SLUG_RE = /^[a-z0-9-]{1,64}$/;
const PERMISSION_RE = /^[a-z_]{1,64}$/;
const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_EVIDENCE = 32 * 1024 * 1024;
const MAX_CALLS = 50000;
const MAX_SOURCES = 50000;
// Darwin's sys/fcntl.h: unlike O_NOFOLLOW, this rejects symlinks in EVERY
// pathname component atomically. Node does not expose the constant. This
// Homebrew-pinned operator tool must refuse persistence on other substrates
// rather than fall back to a check-then-open walk (operator: rerun on macOS).
const NOFOLLOW_ANY = 0x20000000;
const DAY = 86400000;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const roots = () => ['user', 'memberships', ...ORGS.flatMap(o =>
  ['membership', 'org', 'installations', 'orgRulesets', 'repos'].map(k => `${k}:${o}`))];
export const FIXED_STRINGS = Object.freeze([...ORGS, S1A_OPERATOR, SCHEMA, ...FATALS, ...REASONS,
  ...ACTORS, ...MODES, ...LEVELS, ...TYPES, ...SCOPES, 'all', 'selected', 'active',
  'schema', 'runId', 'startedAt', 'finishedAt', 'readerLogin', 'weCommit', 'fatal', 'sources',
  'id', 'parent', 'state', 'reason', 'status', 'data', 'login', 'scopes', 'orgs', 'unlistedAdminOrgs',
  'role', 'public_repos', 'total_private_repos', 'repos', 'total_count', 'installations', 'app_slug',
  'app_id', 'repository_selection', 'permissions', 'ids', 'bypass_actors', 'actor_type', 'actor_id',
  'bypass_mode', 'source_type', 'read', 'failed', 'COMPLETE', 'COMPLETE-WITH-FINDINGS', 'INCOMPLETE',
  'ERROR', 'APP-ADMIN', 'APP-BYPASS', 'KEY-BYPASS', 'HUMAN-BYPASS', 'source', 'code', 'freshUntil',
  'action', 'RERUN', 'OPERATOR-REVIEW', 'user', 'memberships', 'membership', 'org', 'orgRulesets',
  'orgRuleset', 'repoRulesets', 'repoRuleset']);

class Refusal extends Error { constructor(reason) { super(reason); this.reason = reason; } }
const refuse = reason => { throw new Refusal(reason); };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => object(v) && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
function string(v, pattern) {
  if (typeof v !== 'string' || SECRET_RE.test(v) || !pattern.test(v)) refuse('REDACTED-FIELD');
  return v;
}
function number(v, digits = 12) {
  if (typeof v === 'string' && SECRET_RE.test(v)) refuse('REDACTED-FIELD');
  if (!Number.isSafeInteger(v) || v < 0 || !new RegExp(`^[0-9]{1,${digits}}$`).test(String(v))) refuse('REDACTED-FIELD');
  return v;
}
function enumeration(v, allowed, reason = 'UNKNOWN') {
  if (typeof v === 'string' && SECRET_RE.test(v)) refuse('REDACTED-FIELD');
  if (!allowed.includes(v)) refuse(reason);
  return v;
}
function required(v, keys) { if (!object(v) || keys.some(k => !Object.hasOwn(v, k))) refuse('MALFORMED'); }
function list(v) { if (!Array.isArray(v)) refuse('MALFORMED'); return v; }
function unique(v) { if (new Set(v).size !== v.length) refuse('MALFORMED'); return v; }
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (object(v)) return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])]));
  return v;
}
function descriptor(id) {
  string(id, /^[A-Za-z0-9._:/-]{1,200}$/);
  if (id === 'user' || id === 'memberships') return { kind: id, parent: null };
  const root = /^(membership|org|installations|orgRulesets|repos):([^:]+)$/.exec(id);
  if (root && ORGS.includes(root[2])) return { kind: root[1], parent: null };
  const orgRule = /^orgRuleset:([^:]+):([0-9]{1,12})$/.exec(id);
  if (orgRule && ORGS.includes(orgRule[1])) return { kind: 'orgRuleset', parent: `orgRulesets:${orgRule[1]}` };
  const r = /^(repoRulesets|repoRuleset):([^/]+)\/([A-Za-z0-9._-]{1,100})(?::([0-9]{1,12}))?$/.exec(id);
  if (r && ORGS.includes(r[2]) && (r[1] === 'repoRuleset') === Boolean(r[4])) {
    string(r[3], REPO_RE);
    return { kind: r[1], parent: r[4] ? `repoRulesets:${r[2]}/${r[3]}` : `repos:${r[2]}` };
  }
  refuse('REDACTED-FIELD');
}
function actors(v) {
  if (v === undefined) refuse('UNKNOWN');
  return list(v).map(a => {
    required(a, ['actor_type', 'actor_id', 'bypass_mode']);
    const actor_type = enumeration(a.actor_type, ACTORS), bypass_mode = enumeration(a.bypass_mode, MODES);
    const id = a.actor_id;
    if (typeof id === 'string') { string(id, /^[0-9]{1,12}$/); refuse('UNKNOWN'); }
    if (actor_type === 'DeployKey' ? id !== null : id === null && actor_type !== 'OrganizationAdmin') refuse('UNKNOWN');
    return { actor_type, actor_id: id === null ? null : number(id), bypass_mode };
  });
}
function dataFor(kind, d) {
  if (!object(d)) refuse('MALFORMED');
  switch (kind) {
    case 'user':
      required(d, ['login', 'scopes']);
      return { login: string(d.login, /^chalbert$/), scopes: unique(list(d.scopes).map(s => enumeration(s, SCOPES))).sort() };
    case 'memberships':
      required(d, ['orgs', 'unlistedAdminOrgs']);
      return { orgs: unique(list(d.orgs).map(o => enumeration(o, ORGS))).sort(), unlistedAdminOrgs: number(d.unlistedAdminOrgs, 4) };
    case 'membership':
      required(d, ['state', 'role']); return { state: enumeration(d.state, ['active']), role: enumeration(d.role, ['admin']) };
    case 'org':
      required(d, ['public_repos', 'total_private_repos']);
      return { public_repos: number(d.public_repos, 6), total_private_repos: number(d.total_private_repos, 6) };
    case 'repos':
      required(d, ['repos']); return { repos: unique(list(d.repos).map(r => string(r, REPO_RE))).sort() };
    case 'installations': {
      required(d, ['total_count', 'installations']);
      const installations = list(d.installations).map(i => {
        required(i, ['id', 'app_slug', 'app_id', 'repository_selection']);
        if (!object(i.permissions)) refuse('UNKNOWN');
        const permissions = Object.fromEntries(Object.entries(i.permissions).map(([k, level]) => [string(k, PERMISSION_RE), enumeration(level, LEVELS)]));
        return { id: number(i.id), app_slug: string(i.app_slug, SLUG_RE), app_id: number(i.app_id),
          repository_selection: enumeration(i.repository_selection, ['all', 'selected']), permissions };
      });
      unique(installations.map(i => i.id)); return { total_count: number(d.total_count, 6), installations };
    }
    case 'orgRulesets': case 'repoRulesets':
      required(d, ['ids']); return { ids: unique(list(d.ids).map(id => number(id))).sort((a, b) => a - b) };
    case 'orgRuleset': return { bypass_actors: actors(d.bypass_actors) };
    case 'repoRuleset': return { source_type: enumeration(d.source_type, TYPES), bypass_actors: actors(d.bypass_actors) };
    default: refuse('MALFORMED');
  }
}
const equalShape = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function strictData(kind, data) {
  const projected = dataFor(kind, data);
  if (!exact(data, Object.keys(projected))) return false;
  if (kind === 'installations' && data.installations.some(i => !exact(i,
    ['id', 'app_slug', 'app_id', 'repository_selection', 'permissions']))) return false;
  if (['orgRuleset', 'repoRuleset'].includes(kind) && data.bypass_actors.some(a =>
    !exact(a, ['actor_type', 'actor_id', 'bypass_mode']))) return false;
  return equalShape(data, projected);
}
export function validateRecord(r) {
  try {
    if (!exact(r, ['schema', 'runId', 'startedAt', 'finishedAt', 'readerLogin', 'weCommit', 'fatal', 'sources']) || r.schema !== SCHEMA) return false;
    string(r.runId, RUN_RE); string(r.startedAt, TIME_RE); string(r.finishedAt, TIME_RE); string(r.weCommit, COMMIT_RE);
    if (!Array.isArray(r.sources) || r.sources.length > MAX_SOURCES) return false;
    if (r.fatal !== null) return FATALS.includes(r.fatal) && r.readerLogin === null && r.sources.length === 0;
    if (r.readerLogin !== S1A_OPERATOR) return false;
    if (!roots().every(id => r.sources.filter(s => s?.id === id).length === 1)) return false;
    for (const s of r.sources) {
      if (!exact(s, ['id', 'parent', 'state', 'reason', 'status', 'data'])) return false;
      const { kind, parent } = descriptor(s.id);
      if (s.parent !== parent || s.status !== null && (!Number.isInteger(s.status) || !/^[1-9][0-9]{2}$/.test(String(s.status)))) return false;
      if (s.state === 'failed') { if (!REASONS.includes(s.reason) || s.data !== null) return false; }
      else if (s.state === 'read') {
        // Comparing the projected shape rejects every extra nested key as well.
        if (s.reason !== null || s.status !== 200 || !strictData(kind, s.data)) return false;
      } else return false;
    }
    return true;
  } catch (e) { if (e instanceof Refusal) return false; throw e; }
}

export const childEnvironment = home => ({ HOME: home, PATH: '/usr/bin:/bin', LANG: 'C', NO_COLOR: '1',
  GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' });
/** Hard kill deadline, bounded combined output, and close awaited for child reaping. */
export function spawnBounded(executable, argv, { env, timeoutMs }) {
  return new Promise(done => {
    let child;
    try { child = childProcess.spawn(executable, argv, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env }); }
    catch { done({ code: null, stdout: '', stderr: '', timedOut: false, failed: true }); return; }
    let stdout = '', stderr = '', bytes = 0, timedOut = false, failed = false;
    const timer = setTimeout(() => { timedOut = true; if (!child.kill('SIGKILL')) failed = true; }, timeoutMs);
    const read = stream => chunk => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) { failed = true; if (!child.kill('SIGKILL')) failed = true; return; }
      if (stream === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', read('stdout')); child.stderr.on('data', read('stderr'));
    child.on('error', () => { failed = true; });
    child.on('close', code => { clearTimeout(timer); done({ code, stdout, stderr, timedOut, failed }); });
  });
}
export const defaultRunner = spawnBounded;
function clock(c) {
  const d = new Date(typeof c.now === 'function' ? c.now() : c.now ?? new Date());
  if (!Number.isFinite(d.getTime())) refuse('COHORT'); return d;
}
function et(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' }).formatToParts(date).map(p => [p.type, p.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${p.timeZoneName.replace('GMT', '')}`;
}
function context(o) {
  return { ...o, root: resolve(o.root ?? ROOT), fs: o.fs ?? fs, home: o.home ?? process.env.HOME, run: o.run ?? defaultRunner,
    stdout: o.stdout ?? (s => process.stdout.write(s)), stderr: o.stderr ?? (s => process.stderr.write(s)) };
}
const fatalRecord = (r, fatal) => ({ ...r, readerLogin: null, fatal, sources: [] });

/** One typed output choke point, including the serialized last-chance secret check. */
export async function emit(c, kind, value, path) {
  let text;
  if (kind === 'inventory') {
    if (!validateRecord(value)) value = fatalRecord(value, 'SELF-SCHEMA');
    text = JSON.stringify(value) + '\n';
    if (SECRET_RE.test(text)) { value = fatalRecord(value, 'SECRET-DETECTED'); text = JSON.stringify(value) + '\n'; }
  } else if (kind === 'run') { string(value, RUN_RE); text = `runId=${value}\n`; }
  else if (kind === 'result') {
    enumeration(value.result, ['ERROR', 'INCOMPLETE', 'COMPLETE-WITH-FINDINGS', 'COMPLETE']);
    if (value.runId !== undefined) string(value.runId, RUN_RE);
    if (value.freshUntil !== undefined) string(value.freshUntil, TIME_RE);
    text = value.result + (value.runId ? ` runId=${value.runId}` : '') + (value.freshUntil ? ` freshUntil=${value.freshUntil}` : '') + '\n';
    for (const reason of value.reasons ?? []) {
      enumeration(reason, [...REASONS, ...FATALS]);
      text += `reason=${reason} action=${['COHORT', 'UNREAD', 'UNSTABLE', 'RATE-LIMITED'].includes(reason) ? 'RERUN' : 'OPERATOR-REVIEW'}\n`;
    }
    for (const f of value.findings ?? []) {
      enumeration(f.code, ['APP-ADMIN', 'APP-BYPASS', 'KEY-BYPASS', 'HUMAN-BYPASS']); descriptor(f.source);
      text += `code=${f.code} source=${f.source}\n`;
    }
  } else refuse('SELF-SCHEMA');
  if (SECRET_RE.test(text)) { text = 'ERROR SECRET-DETECTED\n'; value = { result: 'ERROR', exitCode: 1, reasons: ['SECRET-DETECTED'] }; }
  if (Buffer.byteLength(text) > MAX_EVIDENCE) {
    if (kind !== 'inventory') refuse('SELF-SCHEMA');
    value = fatalRecord(value, 'SELF-SCHEMA');
    text = JSON.stringify(value) + '\n';
  }
  if (path) {
    if (platform() !== 'darwin') refuse('COHORT');
    await containment(c, false);
    const directory = dirname(path), st = await c.fs.lstat(directory);
    if (st.isSymbolicLink() || !st.isDirectory() || await c.fs.realpath(directory) !== directory) refuse('COHORT');
    // O_NOFOLLOW_ANY also covers the leaf; Darwin rejects combining the two flags.
    const h = await c.fs.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW_ANY, 0o600);
    try { await h.writeFile(text, 'utf8'); } finally { await h.close(); }
  } else await c.stdout(text);
  return value;
}
async function containment(c, create) {
  c.root = await c.fs.realpath(c.root);
  const paths = ['state', 'state/credential-cutover', 'state/credential-cutover/runs'].map(p => join(c.root, p));
  // Inspect ALL ancestors before creating any of them. Missing ancestors are created only by inventory.
  for (const path of paths) {
    try { const st = await c.fs.lstat(path); if (st.isSymbolicLink() || !st.isDirectory()) refuse('COHORT'); }
    catch (e) { if (e.code !== 'ENOENT' || !create) throw e; }
  }
  if (create) for (const path of paths) {
    try { await c.fs.mkdir(path, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const st = await c.fs.lstat(path); if (st.isSymbolicLink() || !st.isDirectory()) refuse('COHORT');
  }
  const base = paths.at(-1);
  if (await c.fs.realpath(base) !== base) refuse('COHORT'); return base;
}
async function locate(c, runId) {
  string(runId, RUN_RE);
  const base = await containment(c, false), directory = join(base, runId), st = await c.fs.lstat(directory);
  if (st.isSymbolicLink() || !st.isDirectory()) refuse('COHORT');
  const real = await c.fs.realpath(directory), rel = relative(base, real);
  if (real !== directory || rel.startsWith('..') || isAbsolute(rel)) refuse('COHORT'); return directory;
}
function allowedEndpoint(path) {
  const u = new URL(path, 'https://api.github.com');
  if (u.origin !== 'https://api.github.com' || path !== `${u.pathname}${u.search}`) return false;
  const p = u.pathname; let keys = [], allowed = p === '/user';
  if (p === '/user/memberships/orgs') { allowed = u.searchParams.get('state') === 'active'; keys = ['state', 'per_page', 'page']; }
  for (const o of ORGS) {
    if ([`/user/memberships/orgs/${o}`, `/orgs/${o}`].includes(p)) allowed = true;
    if ([`/orgs/${o}/installations`, `/orgs/${o}/rulesets`].includes(p)) { allowed = true; keys = ['per_page', 'page']; }
    if (p === `/orgs/${o}/repos`) { allowed = u.searchParams.get('type') === 'all'; keys = ['type', 'per_page', 'page']; }
    if (new RegExp(`^/orgs/${o}/rulesets/[0-9]{1,12}$`).test(p)) allowed = true;
    const r = new RegExp(`^/repos/${o}/([A-Za-z0-9._-]{1,100})/rulesets(?:/[0-9]{1,12})?$`).exec(p);
    if (r && !SECRET_RE.test(r[1])) { allowed = u.searchParams.get('includes_parents') === 'true'; keys = ['includes_parents', 'per_page', 'page']; }
  }
  return allowed && [...u.searchParams].every(([k, v]) => keys.includes(k) && (k !== 'per_page' || v === '100') && (k !== 'page' || /^[1-9][0-9]{0,5}$/.test(v)))
    && new Set([...u.searchParams.keys()]).size === [...u.searchParams.keys()].length;
}
async function request(c, path, budget) {
  if (!allowedEndpoint(path)) refuse('MALFORMED');
  if (++budget.calls > MAX_CALLS || clock(c).getTime() - budget.started > 7200000) refuse('UNREAD');
  let out;
  try { out = await c.run('/opt/homebrew/bin/gh', ['api', '--include', '--method', 'GET', path], { env: childEnvironment(c.home), timeoutMs: 30000 }); }
  catch { refuse('UNREAD'); }
  if (!out || out.timedOut || out.failed || typeof out.stdout !== 'string' || Buffer.byteLength(out.stdout) > MAX_OUTPUT) refuse('UNREAD');
  const separator = /\r?\n\r?\n/.exec(out.stdout);
  if (!separator) refuse('UNREAD');
  const head = out.stdout.slice(0, separator.index).split(/\r?\n/);
  const m = /^HTTP\/(?:1\.[01]|2(?:\.0)?) ([1-5][0-9]{2})(?:[^\r\n]*)$/.exec(head.shift());
  if (!m) refuse('UNREAD');
  const status = Number(m[1]), headers = {};
  const fail = reason => { throw Object.assign(new Refusal(reason), { status }); };
  for (const line of head) {
    const h = /^([A-Za-z0-9-]+):[ \t]*(.*)$/.exec(line);
    if (!h || Object.hasOwn(headers, h[1].toLowerCase())) fail('MALFORMED');
    headers[h[1].toLowerCase()] = h[2].trim();
  }
  if (status === 401) fail('AUTH-FAILED');
  if (Object.hasOwn(headers, 'x-github-sso')) fail('UNREAD');
  if ([403, 429].includes(status) && (headers['x-ratelimit-remaining'] === '0' || Object.hasOwn(headers, 'retry-after'))) fail('RATE-LIMITED');
  if (status !== 200 || out.code !== 0) fail('UNREAD');
  let body; try { body = JSON.parse(out.stdout.slice(separator.index + separator[0].length)); } catch { fail('MALFORMED'); }
  return { body, headers, status };
}
function pageKey(path) {
  const u = new URL(path, 'https://api.github.com');
  if (!u.searchParams.has('page')) u.searchParams.set('page', '1'); u.searchParams.sort(); return u.href;
}
function nextPage(link, current, visited) {
  if (link === undefined) return null;
  const links = link.split(',').map(p => /^\s*<([^>]+)>;\s*rel="(next|prev|first|last)"\s*$/.exec(p));
  if (links.some(p => !p) || links.filter(p => p[2] === 'next').length > 1) refuse('MALFORMED');
  const next = links.find(p => p[2] === 'next'); if (!next) return null;
  let u; try { u = new URL(next[1]); } catch { refuse('MALFORMED'); }
  const original = new URL(current, 'https://api.github.com');
  if (u.origin !== original.origin || u.username || u.password || u.hash || u.pathname !== original.pathname) refuse('MALFORMED');
  const query = u => [...u.searchParams].filter(([k]) => k !== 'page').sort();
  if (JSON.stringify(query(u)) !== JSON.stringify(query(original)) || !/^[1-9][0-9]{0,5}$/.test(u.searchParams.get('page') ?? '')
    || new Set([...u.searchParams.keys()]).size !== [...u.searchParams.keys()].length) refuse('MALFORMED');
  const path = `${u.pathname}${u.search}`;
  if (Number(u.searchParams.get('page')) !== Number(original.searchParams.get('page') ?? '1') + 1
    || visited.has(pageKey(path))) refuse('MALFORMED'); return path;
}
async function pages(c, path, budget, installations = false) {
  const u = new URL(path, 'https://api.github.com'); u.searchParams.set('per_page', '100');
  const initial = `${u.pathname}${u.search}`; let current = initial, items = [], total;
  const visited = new Set();
  for (let page = 0; page < 100; page++) {
    visited.add(pageKey(current)); const out = await request(c, current, budget); let chunk = out.body;
    if (installations) {
      required(chunk, ['total_count', 'installations']); const count = number(chunk.total_count, 6);
      if (total !== undefined && total !== count) refuse('COHORT'); total = count; chunk = chunk.installations;
    }
    if (list(chunk).length > 100) refuse('MALFORMED'); items.push(...chunk);
    current = nextPage(out.headers.link, current, visited);
    if (!current) return installations ? { total_count: total, installations: items } : items;
  }
  refuse('MALFORMED');
}
const failed = (id, reason, status = null) => ({ id, parent: descriptor(id).parent, state: 'failed', reason, status, data: null });
async function pass(c, budget) {
  const sources = [];
  async function read(id, load) {
    if (sources.length >= MAX_SOURCES) refuse('SELF-SCHEMA');
    try {
      const data = canonical(dataFor(descriptor(id).kind, await load()));
      sources.push({ id, parent: descriptor(id).parent, state: 'read', reason: null, status: 200, data }); return data;
    } catch (e) {
      if (!(e instanceof Refusal) || FATALS.includes(e.reason)) throw e;
      sources.push(failed(id, e.reason, e.status ?? null)); return null;
    }
  }
  const user = await read('user', async () => {
    const { body, headers } = await request(c, '/user', budget); required(body, ['login']);
    if (typeof body.login !== 'string') refuse('MALFORMED');
    if (SECRET_RE.test(body.login)) refuse('SECRET-DETECTED');
    if (body.login !== S1A_OPERATOR) refuse('READER-NOT-OPERATOR');
    const scopes = unique((headers['x-oauth-scopes'] ?? '').split(',').map(s => s.trim()).filter(s => SCOPES.includes(s))).sort();
    if (!scopes.includes('repo') || !scopes.some(s => ['read:org', 'admin:org'].includes(s))) refuse('READER-SCOPE');
    return { login: body.login, scopes };
  });
  if (!user) return [...sources, ...roots().filter(id => id !== 'user').map(id => failed(id, 'UNREAD'))];
  await read('memberships', async () => {
    const found = await pages(c, '/user/memberships/orgs?state=active', budget), known = [], others = new Set();
    for (const m of found) {
      required(m, ['state', 'role', 'organization']); required(m.organization, ['login']);
      if (typeof m.organization.login !== 'string' || !m.organization.login || !['active', 'pending'].includes(m.state) || !['admin', 'member'].includes(m.role)) refuse('MALFORMED');
      if (m.state === 'active' && m.role === 'admin') {
        if (ORGS.includes(m.organization.login)) known.push(m.organization.login); else others.add(m.organization.login);
      }
    }
    return { orgs: known, unlistedAdminOrgs: others.size };
  });
  for (const o of ORGS) {
    const membership = await read(`membership:${o}`, async () => {
      const { body } = await request(c, `/user/memberships/orgs/${o}`, budget); required(body, ['state', 'role']);
      if (body.state !== 'active' || body.role !== 'admin') refuse('UNREAD'); return { state: body.state, role: body.role };
    });
    if (!membership) { sources.push(...['org', 'installations', 'orgRulesets', 'repos'].map(k => failed(`${k}:${o}`, 'UNREAD'))); continue; }
    await read(`org:${o}`, async () => (await request(c, `/orgs/${o}`, budget)).body);
    await read(`installations:${o}`, () => pages(c, `/orgs/${o}/installations`, budget, true));
    const rules = await read(`orgRulesets:${o}`, async () => ({ ids: (await pages(c, `/orgs/${o}/rulesets`, budget)).map(r => { required(r, ['id']); return r.id; }) }));
    for (const id of rules?.ids ?? []) await read(`orgRuleset:${o}:${id}`, async () => (await request(c, `/orgs/${o}/rulesets/${id}`, budget)).body);
    const repos = await read(`repos:${o}`, async () => ({ repos: (await pages(c, `/orgs/${o}/repos?type=all`, budget)).map(r => { required(r, ['name']); return r.name; }) }));
    for (const r of repos?.repos ?? []) {
      const rules = await read(`repoRulesets:${o}/${r}`, async () => ({ ids: (await pages(c, `/repos/${o}/${r}/rulesets?includes_parents=true`, budget)).map(rule => { required(rule, ['id']); return rule.id; }) }));
      for (const id of rules?.ids ?? []) await read(`repoRuleset:${o}/${r}:${id}`, async () => (await request(c, `/repos/${o}/${r}/rulesets/${id}?includes_parents=true`, budget)).body);
    }
  }
  return sources;
}
function snapshot(first, second) {
  const a = new Map(first.map(s => [s.id, s])), b = new Map(second.map(s => [s.id, s]));
  return [...new Set([...a.keys(), ...b.keys()])].sort().map(id => {
    const x = a.get(id), y = b.get(id);
    if (!x || !y || x.state === 'read' && y.state === 'read' && !equalShape(x.data, y.data)) return failed(id, 'UNSTABLE');
    return x.state === 'failed' ? x : y;
  });
}
export async function inventory(options = {}) {
  const c = context(options); let record;
  try {
    string(c.commit, COMMIT_RE);
    if (typeof c.home !== 'string' || !isAbsolute(c.home)) refuse('COHORT');
    const started = clock(c), startedAt = et(started), entropy = (c.randomBytes ?? randomBytes)(4).toString('hex');
    const runId = `${startedAt.slice(0, 19).replaceAll('-', '').replaceAll(':', '')}-${entropy}`; string(runId, RUN_RE);
    record = { schema: SCHEMA, runId, startedAt, finishedAt: startedAt, readerLogin: null, weCommit: c.commit, fatal: null, sources: [] };
    const base = await containment(c, true), directory = join(base, runId);
    await c.fs.mkdir(directory, { mode: 0o700 }); // Exclusive: collisions never resume.
    await emit(c, 'run', runId);
    try {
      const budget = { calls: 0, started: started.getTime() }, first = await pass(c, budget);
      // A failed pass already refuses completion. Never retry its failed reads (especially quota failures).
      record.readerLogin = S1A_OPERATOR;
      record.sources = first.some(s => s.state === 'failed') ? first : snapshot(first, await pass(c, budget));
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      record = fatalRecord(record, FATALS.includes(e.reason) ? e.reason : 'SELF-SCHEMA');
    }
    record.finishedAt = et(clock(c)); record = await emit(c, 'inventory', record, join(directory, 'inventory.json'));
    return { exitCode: record.fatal ? 1 : 0, record };
  } catch {
    await emit(c, 'result', { result: 'ERROR', reasons: ['COHORT'] }); return { exitCode: 1, result: 'ERROR', reasons: ['COHORT'] };
  }
}
function evaluate(r, runId, now) {
  const findings = [], reasons = new Set();
  const result = (name, exitCode) => ({ result: name, exitCode, runId, findings, reasons: [...reasons].sort(),
    ...(validateRecord(r) && Number.isFinite(Date.parse(r.startedAt)) ? { freshUntil: et(new Date(Date.parse(r.startedAt) + DAY)) } : {}) });
  if (!validateRecord(r) || r.runId !== runId) { reasons.add('COHORT'); return result('INCOMPLETE', 20); }
  if (r.fatal) { reasons.add(r.fatal); return result('ERROR', 1); }
  const start = Date.parse(r.startedAt), finish = Date.parse(r.finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(finish) || start > finish || finish > now.getTime() || finish - start > 7200000 || now.getTime() - start > DAY) reasons.add('COHORT');
  const byId = new Map(r.sources.map(s => [s.id, s])); if (byId.size !== r.sources.length) reasons.add('COHORT');
  const expected = new Set(roots());
  for (const s of r.sources) {
    if (s.state === 'failed') { reasons.add(s.reason); continue; }
    const { kind } = descriptor(s.id);
    if (kind === 'repos') for (const repo of s.data.repos) expected.add(`repoRulesets:${s.id.slice(6)}/${repo}`);
    if (kind === 'orgRulesets') for (const id of s.data.ids) expected.add(`orgRuleset:${s.id.slice(12)}:${id}`);
    if (kind === 'repoRulesets') for (const id of s.data.ids) expected.add(`repoRuleset:${s.id.slice(13)}:${id}`);
    if (kind === 'user' && (s.data.login !== r.readerLogin || !s.data.scopes.includes('repo') || !s.data.scopes.some(scope => ['read:org', 'admin:org'].includes(scope)))) reasons.add('COHORT');
    if (kind === 'memberships') {
      if (s.data.unlistedAdminOrgs > 0) reasons.add('ORG-UNLISTED');
      if (!ORGS.every(o => s.data.orgs.includes(o))) reasons.add('COHORT');
    }
    if (kind === 'installations') {
      if (s.data.installations.length !== s.data.total_count) reasons.add('COHORT');
      for (const i of s.data.installations) if (Object.entries(i.permissions).some(([name, level]) => level === 'admin'
        || (name === 'administration' || name.endsWith('_administration')) && level === 'write')) findings.push({ code: 'APP-ADMIN', source: s.id });
    }
    if (kind === 'orgRuleset' || kind === 'repoRuleset') for (const a of s.data.bypass_actors) findings.push({
      code: a.actor_type === 'Integration' ? 'APP-BYPASS' : a.actor_type === 'DeployKey' ? 'KEY-BYPASS' : 'HUMAN-BYPASS', source: s.id });
  }
  for (const id of expected) if (!byId.has(id)) reasons.add('COHORT');
  for (const id of byId.keys()) if (!expected.has(id)) reasons.add('COHORT');
  for (const o of ORGS) {
    const org = byId.get(`org:${o}`), repos = byId.get(`repos:${o}`);
    if (org?.state === 'read' && repos?.state === 'read' && repos.data.repos.length !== org.data.public_repos + org.data.total_private_repos) reasons.add('COHORT');
  }
  if (reasons.size) return result('INCOMPLETE', 20);
  if (findings.some(f => f.code !== 'HUMAN-BYPASS')) return result('COMPLETE-WITH-FINDINGS', 10);
  return result('COMPLETE', 0);
}
async function persistDecision(c, directory, decision) {
  await emit(c, 'result', decision, join(directory, 'result.txt')); await emit(c, 'result', decision); return decision;
}
export async function aggregate(options = {}) {
  const c = context(options);
  try {
    string(c.runId, RUN_RE); const directory = await locate(c, c.runId), path = join(directory, 'inventory.json'); let r;
    try {
      const st = await c.fs.lstat(path); if (st.isSymbolicLink() || !st.isFile()) refuse('COHORT');
      if (st.size > MAX_EVIDENCE) return await persistDecision(c, directory, evaluate(null, c.runId, clock(c)));
      const h = await c.fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW); let text;
      try {
        const live = await h.stat(); if (!live.isFile() || live.size > MAX_EVIDENCE || live.ino !== st.ino || live.dev !== st.dev) refuse('COHORT');
        const buffer = Buffer.alloc(MAX_EVIDENCE + 1), { bytesRead } = await h.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_EVIDENCE) refuse('COHORT'); text = buffer.subarray(0, bytesRead).toString('utf8');
      } finally { await h.close(); }
      try { r = JSON.parse(text); } catch { r = null; }
    } catch (e) {
      // Symlinks/containment are tool errors; unreadable evidence is an incomplete cohort.
      if (e instanceof Refusal || ['ELOOP', 'ENOTDIR'].includes(e.code)) throw e;
      r = null;
    }
    return await persistDecision(c, directory, evaluate(r, c.runId, clock(c)));
  } catch {
    const d = { result: 'ERROR', exitCode: 1, reasons: ['COHORT'] }; await emit(c, 'result', d); return d;
  }
}
export async function admissionCheck(options = {}) {
  const c = context(options), run = await inventory(c);
  if (!run.record) return { ...run, allowed: false };
  try {
    const d = evaluate(run.record, run.record.runId, clock(c)), directory = await locate(c, run.record.runId);
    await persistDecision(c, directory, d); return { ...d, allowed: d.exitCode === 0 };
  } catch {
    const d = { result: 'ERROR', exitCode: 1, reasons: ['COHORT'], allowed: false }; await emit(c, 'result', d); return d;
  }
}
export async function runCli(argv, options = {}) {
  const c = context(options), mode = argv[0];
  const valid = argv.length === 2 && (mode === '--inventory' && /^--commit=[0-9a-f]{40}$/.test(argv[1]) || mode === '--aggregate' && /^--run=[0-9]{8}T[0-9]{6}-[0-9a-f]{8}$/.test(argv[1]));
  if (valid) return mode === '--inventory' ? inventory({ ...c, commit: argv[1].slice(9) }) : aggregate({ ...c, runId: argv[1].slice(6) });
  const d = { result: 'ERROR', exitCode: 1, reasons: ['COHORT'] }; await emit(c, 'result', d); return d;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = (await runCli(process.argv.slice(2))).exitCode;
