// @vitest-environment node
/**
 * @file drain-api-reads.test.mjs - R515/R546: the drain's freeze, high-water-mark and bornAs reads go through
 *   GitHub REST + ETag (setting drain.reads.source), fail CLOSED with a named transient reason, never fall back to git.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ghRestGetJson } from '../gh-rest-read.mjs';
import { createHash } from 'node:crypto';
import { DRAIN_READ_TRANSIENT, DrainReadError, createRestSource, isTransientReadFailure, readAddedFiles, readBacklogNames, readBranchSha, readFileAtRef, readOriginSlug, resolveDrainReadsSource, unwrap } from '../drain-api-reads.mjs';
import { readSharedFreeze, SHARED_FREEZE_FILE } from '../red-main-freeze-shared.mjs';
import { readNumberingEvidence } from '../card-number-allocator.mjs';
import { checkBornAsCollision, guardEnqueue } from '../drain-poison-guard.mjs';
import { finishBranchPreparation } from '../queue-branch-numbering.mjs';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const blobSha = (text) => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(Buffer.from(text)).digest('hex');
const b64 = (text) => ({ type: 'file', encoding: 'base64', size: Buffer.byteLength(text), sha: blobSha(text), content: Buffer.from(text).toString('base64') });
const ok = (json) => ({ status: 200, json, notModified: false });
const http = (status) => Object.assign(new Error(`gh: HTTP ${status}`), { httpStatus: status });
/** A REST fake keyed by path substring; a function value throws/returns per call. */
const routes = (table) => { const seen = []; const rest = (path) => {
  seen.push(path);
  const full = { ...table, 'git/ref/heads/': ok({ object: { sha: SHA } }) }; // default: every branch is at SHA
  const hit = Object.keys(full).find((k) => path.includes(k));
  if (!hit) throw http(404);
  const v = typeof full[hit] === 'function' ? full[hit](path) : full[hit];
  if (v instanceof Error) throw v;
  return v;
}; rest.seen = seen; return rest; };
/** Routes for one file at SHA: commit -> trees along the path -> contents. `contents` overrides the contents response, `entry` the tree entry. */
const fileWorld = (path, doc, { contents, entry = {} } = {}) => {
  const parts = path.split('/');
  const t = { 'git/commits/': ok({ tree: { sha: 'rt0' } }) };
  parts.forEach((name, i) => {
    t[`git/trees/rt${i}`] = ok({ tree: [{ path: name, type: i < parts.length - 1 ? 'tree' : 'blob', mode: '100644', sha: i < parts.length - 1 ? `rt${i + 1}` : doc?.sha, ...(i === parts.length - 1 ? entry : {}) }] });
  });
  t[`contents/${path}`] = contents ?? ok(doc);
  return t;
};
/** Routes for main's backlog/ listing at SHA. */
const hwWorld = (names, { bk, over = {} } = {}) => ({
  'git/commits/': ok({ tree: { sha: 'rt0' } }),
  'git/trees/rt0': ok({ tree: [{ path: 'backlog', type: 'tree', sha: 'bk' }] }),
  'git/trees/bk': bk ?? ok({ tree: names.map((n) => ({ path: n, type: 'blob', mode: '100644' })) }),
  ...over,
});
const noGit = (calls = []) => (...a) => { calls.push(a); throw new Error('git must not run'); };
const FREEZE = JSON.stringify({ frozen: true, kind: 'manual', reason: 'r', at: 't' });

describe('drain.reads.source setting', () => {
  it('defaults to api, takes tool setting and env, ignores junk', () => {
    expect(resolveDrainReadsSource({ env: {}, file: {}, platform: {} })).toMatchObject({ value: 'api', source: 'default' });
    expect(resolveDrainReadsSource({ env: {}, file: { drain: { reads: { source: 'git' } } }, platform: {} })).toMatchObject({ value: 'git', source: 'settings' });
    expect(resolveDrainReadsSource({ env: { WE_DRAIN_READS_SOURCE: 'git' }, file: {}, platform: {} }).value).toBe('git');
    expect(resolveDrainReadsSource({ env: { WE_DRAIN_READS_SOURCE: 'bogus' }, file: {}, platform: {} }).value).toBe('api');
    // Only a test runner flips the standard default to the stubbed-git path; an explicit setting still wins there.
    expect(resolveDrainReadsSource({ env: { VITEST: 'true' }, file: {}, platform: {} }).value).toBe('git');
    expect(resolveDrainReadsSource({ env: { VITEST: 'true', WE_DRAIN_READS_SOURCE: 'api' }, file: {}, platform: {} }).value).toBe('api');
  });
});

describe('freeze read over REST', () => {
  const read = (rest) => readSharedFreeze({ board: '/x', branch: 'ops/red-main-freeze', readsSource: 'api', rest, slug: 'o/r' });
  it('success: parses the doc without a git process', () => {
    const rest = routes(fileWorld(SHARED_FREEZE_FILE, b64(FREEZE)));
    expect(read(rest)).toMatchObject({ frozen: true, kind: 'manual' });
    expect(rest.seen[0]).toContain('git/ref/heads/ops/red-main-freeze');
    expect(rest.seen.at(-1)).toContain(`ref=${SHA}`); // the contents read is pinned to the resolved commit
  });
  it('304: the ETag reader serves the cached body', () => {
    const rest = routes(fileWorld(SHARED_FREEZE_FILE, b64(FREEZE), { contents: { status: 304, notModified: true, json: b64(FREEZE) } }));
    expect(read(rest)).toMatchObject({ frozen: true });
  });
  it('real ETag reader: second call is a conditional 304 that costs no refetch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'etag-'));
    let n = 0;
    const table = fileWorld(SHARED_FREEZE_FILE, b64(FREEZE));
    table['git/ref/heads/'] = ok({ object: { sha: SHA } });
    const exec = (cmd, argv) => {
      const path = argv[argv.length - 1];
      const hit = Object.keys(table).find((k) => path.includes(k));
      if (argv[0] === 'api' && argv.includes('If-None-Match: "e1"')) throw Object.assign(new Error('gh: HTTP 304'), { stdout: 'HTTP/2.0 304 Not Modified\r\netag: "e1"\r\n\r\n', stderr: 'gh: HTTP 304' });
      n += 1;
      return `HTTP/2.0 200 OK\r\netag: "e1"\r\n\r\n${JSON.stringify(table[hit].json)}`;
    };
    const rest = (path, o) => ghRestGetJson(path, { ...o, exec, dir, env: { ...o.env, WE_GH_ETAG_CACHE: '1' } });
    expect(read(rest)).toMatchObject({ frozen: true });
    const first = n;
    expect(first).toBeGreaterThan(0);
    expect(read(rest)).toMatchObject({ frozen: true });
    expect(n).toBe(first); // every call of the second read was a conditional 304
  });
  it('5xx: fails closed with a named transient reason', () => {
    const r = read(routes(fileWorld(SHARED_FREEZE_FILE, b64(FREEZE), { contents: http(502) })));
    expect(r.frozen).toBeUndefined();
    expect(r.transient).toBe(true);
    expect(r.error).toContain('api-http-502');
    expect(isTransientReadFailure(r.error)).toBe(true);
  });
  it('malformed response fails closed', () => {
    expect(read(routes(fileWorld(SHARED_FREEZE_FILE, b64(FREEZE), { contents: ok({ type: 'dir' }) }))).error).toContain('api-malformed');
    expect(read(routes(fileWorld(SHARED_FREEZE_FILE, b64('not json')))).error).toContain('not JSON');
  });
});

describe('origin/main high-water mark over REST', () => {
  const tree = (names, extra = {}) => ({ tree: names.map((path) => ({ path, type: 'blob' })), ...extra });
  const base = (over = {}) => routes(hwWorld(['100-a.md', '7-b.md', 'README.md'], { over }));
  it('uses the git callback checkout as the REST repository context', () => {
    const seenCwd = [];
    const rest = (path, o) => { seenCwd.push(o.context); return base()(path, o); };
    readNumberingEvidence((a) => (a[0] === 'rev-parse' ? '/the/checkout\n' : ''), 'origin', { source: 'api', rest, slug: 'o/r' });
    expect(seenCwd.length).toBeGreaterThan(0);
    expect(new Set(seenCwd)).toEqual(new Set(['o/r@/the/checkout']));
  });
  const run = (rest, git = noGit()) => readNumberingEvidence(git, 'origin', { source: 'api', rest, cwd: '/c', slug: 'o/r' });
  const refsGit = (calls) => (args) => { calls.push(args); if (args[0] === 'ls-remote') return ''; throw new Error('only ls-remote allowed'); };
  it('success: max card number from the REST tree, no fetch/ls-tree', () => {
    const calls = [];
    expect(Math.max(...run(base(), refsGit(calls)).main)).toBe(100);
    expect(calls.map((c) => c[0])).toEqual(['ls-remote']);
  });
  it('304 path: cached trees are used as-is', () => {
    const rest = routes({
      'git/commits/': { status: 304, notModified: true, json: { tree: { sha: 'rt0' } } },
      'git/trees/rt0': { status: 304, notModified: true, json: { tree: [{ path: 'backlog', type: 'tree', sha: 'bk' }] } },
      'git/trees/bk': { status: 304, notModified: true, json: tree(['5-a.md']) },
    });
    expect(run(rest, refsGit([])).main).toEqual([5]);
  });
  it('5xx: unavailable, transient, named, no git fallback', () => {
    const calls = [];
    expect(() => run(base({ 'git/trees/bk': http(503) }), noGit(calls))).toThrow(new RegExp(`high-water mark unavailable: ${DRAIN_READ_TRANSIENT} \\(high-water-mark: api-http-503\\)`));
    expect(calls).toEqual([]);
  });
  it('malformed or truncated tree fails closed', () => {
    expect(() => run(base({ 'git/trees/bk': ok({ nope: 1 }) }))).toThrow(/api-malformed/);
    expect(() => run(base({ 'git/trees/bk': ok(tree(['1-a.md'], { truncated: true })) }))).toThrow(/api-truncated/);
    expect(() => run(base({ 'git/trees/rt0': ok({ tree: [] }) }))).toThrow(/api-malformed/);
  });
  it('refreshTracking: stale local ref after a failed fetch fails closed; a current ref needs no fetch', () => {
    const rest = base({ 'git/ref/heads/main': ok({ object: { sha: SHA } }) });
    const git = (local, calls) => (args) => { calls.push(args[0]); if (args[0] === 'rev-parse') return `${local}\n`; if (args[0] === 'ls-remote') return ''; throw new Error('fetch ETIMEDOUT'); };
    const stale = [];
    expect(() => readNumberingEvidence(git(OTHER, stale), 'origin', { source: 'api', rest, slug: 'o/r', refreshTracking: true })).toThrow(/tracking-ref-stale/);
    const fresh = [];
    readNumberingEvidence(git(SHA, fresh), 'origin', { source: 'api', rest, slug: 'o/r', refreshTracking: true });
    expect(fresh).not.toContain('fetch');
  });
});

describe('bornAs read over REST', () => {
  const CARD = '---\nbornAs: xabc123\n---\nbody\n';
  const args = (rest, git) => ({ exec: (cmd, a) => git(a), headSha: SHA, cwd: undefined, readsSource: 'api', rest, slug: 'o/r' });
  const rest0 = (over = {}) => routes({
    'compare/': ok({ files: [{ filename: 'backlog/xabc123-new.md', status: 'added' }, { filename: 'src/x.ts', status: 'added' }] }),
    ...fileWorld('backlog/xabc123-new.md', b64(CARD)),
    'git/ref/heads/main': ok({ object: { sha: OTHER } }),
    ...over,
  });
  const git = (calls = [], { grep = '' } = {}) => (a) => {
    calls.push(a[0]);
    if (a[0] === 'rev-parse') return `${OTHER}\n`;
    if (a[0] === 'grep') { if (grep) return grep; throw Object.assign(new Error('none'), { status: 1 }); }
    throw new Error(`unexpected git ${a[0]}`);
  };
  it('success: reads added cards over REST; no fetch/diff/show; no collision -> ok', () => {
    const calls = [];
    expect(checkBornAsCollision(args(rest0(), git(calls)))).toEqual({ ok: true });
    expect(calls).toEqual(['rev-parse', 'grep']);
  });
  it('304 path: cached compare and card bodies are used', () => {
    const rest = rest0({ 'compare/': { status: 304, notModified: true, json: { files: [] } } });
    expect(checkBornAsCollision(args(rest, git()))).toEqual({ ok: true });
  });
  it('a real collision is still found', () => {
    const grep = 'origin/main:backlog/12-old.md\0bornAs: xabc123\n';
    const g = (a) => (a[0] === 'show' ? '---\nbornAs: xabc123\n---\nold\n' : git([], { grep })(a));
    expect(checkBornAsCollision(args(rest0(), g))).toMatchObject({ collision: { hash: 'xabc123' } });
  });
  it('5xx: unreadable with a named transient reason; enqueue gives a retry note, not a by-hand text', () => {
    const r = checkBornAsCollision(args(rest0({ 'compare/': http(500) }), git()));
    expect(r.error).toContain('api-http-500');
    const out = guardEnqueue({ c: { num: 9 }, headSha: SHA, repo: 'o/r', exec: (c, a) => git()(a), base: 'main', readsSource: 'api', slug: 'o/r', rest: rest0({ 'compare/': http(500) }) });
    expect(out).toMatchObject({ enqueued: false, deferred: true, kind: 'bornas-unreadable' });
    expect(out.reason).toContain('Retry note');
    expect(out.reason).not.toContain('Inspect main');
  });
  it('malformed or truncated responses fail closed', () => {
    expect(checkBornAsCollision(args(rest0({ 'compare/': ok({ nope: 1 }) }), git())).error).toContain('api-malformed');
    expect(checkBornAsCollision(args(rest0({ 'compare/': ok({ files: new Array(300).fill({ filename: 'a', status: 'modified' }) }) }), git())).error).toContain('compare-ceiling');
    expect(checkBornAsCollision(args(rest0({ 'compare/': ok({ files: [{ filename: 'backlog/xabc123-new.md' }] }) }), git())).error).toContain('api-malformed');
    expect(checkBornAsCollision(args(rest0({ 'compare/': ok({ files: [{ filename: 'backlog/xabc123-new.md', status: 'weird' }] }) }), git())).error).toContain('api-malformed');
    expect(checkBornAsCollision(args(rest0({ 'contents/backlog/xabc123-new.md': ok({ type: 'file', encoding: 'none', content: '' }) }), git())).error).toContain('api-malformed');
  });
  it('a stale origin/main ref (after a failed fetch) fails closed', () => {
    const g = (a) => { if (a[0] === 'rev-parse') return `${SHA}\n`; throw new Error('fetch ETIMEDOUT'); };
    expect(checkBornAsCollision(args(rest0(), g)).error).toContain('tracking-ref-stale');
  });
});

describe('transient numbering failures say retry, real refusals still say by hand', () => {
  const detailFor = (reason) => { const events = []; finishBranchPreparation({ action: 'skip', reason }, { c: { num: 4 }, revalidationAborted: [], needsAcceptanceRestamp: () => false, restampAcceptance: () => ({}), log: { write() {} }, emit: (e) => events.push(e) }); return events[0].detail; };
  it('transient -> retry note; other -> needs-you text', () => {
    const t = detailFor(new DrainReadError('high-water-mark', 'api-http-502').message);
    expect(t).toContain('retry note');
    expect(t).not.toContain('by hand');
    expect(detailFor('merge-queue: branch numbering refused: bad card')).toContain('number it by hand');
  });
});

describe('R549 round: pinned repo, strict base64, 20 s freeze bound', () => {
  const GIT = (url) => () => url;
  it('derives owner/repo from origin (https, ssh, .git) and fails closed otherwise', () => {
    const slug = (url, env = {}) => readOriginSlug(`/c-${Math.random()}`, { env, git: GIT(url) });
    expect(slug('https://github.com/web-everything/web-everything.git\n')).toBe('web-everything/web-everything');
    expect(slug('git@github.com:a/b')).toBe('a/b');
    expect(slug('https://x-access-token:t@github.com/a/b.git')).toBe('a/b');
    expect(() => slug('https://gitlab.com/a/b')).toThrow(/origin-unparseable/);
    expect(() => slug('not a url')).toThrow(/origin-unparseable/);
    expect(() => readOriginSlug(`/c-${Math.random()}`, { git: () => { throw new Error('no origin'); } })).toThrow(/origin-unreadable/);
  });
  it('GH_REPO naming another repo is a mismatch (fail closed); the same repo is fine', () => {
    const d = `/c-${Math.random()}`;
    expect(() => readOriginSlug(d, { env: { GH_REPO: 'evil/other' }, git: GIT('git@github.com:a/b.git') })).toThrow(/repo-mismatch/);
    expect(readOriginSlug(`/c-${Math.random()}`, { env: { GH_REPO: 'A/B' }, git: GIT('git@github.com:a/b.git') })).toBe('a/b');
  });
  it('a pin failure surfaces as a named transient read failure through the callers', () => {
    const r = readSharedFreeze({ board: '/nowhere-' + Math.random(), branch: 'ops/red-main-freeze', readsSource: 'api', rest: routes({}), env: undefined });
    expect(r.frozen).toBeUndefined();
    expect(r.error).toMatch(/origin-unreadable|origin-unparseable|repo-mismatch/);
  });
  it('strict base64: bad alphabet, bad length and non-canonical content fail closed', () => {
    const bad = (content) => readSharedFreeze({ board: '/x', branch: 'ops/b', readsSource: 'api', slug: 'o/r', rest: routes(fileWorld(SHARED_FREEZE_FILE, { type: 'file', encoding: 'base64', content, sha: 'c'.repeat(40) })) }).error;
    expect(bad('!!!!')).toContain('invalid base64');
    expect(bad('abc')).toContain('invalid base64');
    expect(bad('QR==')).toContain('does not round-trip');
    const good = Buffer.from(FREEZE).toString('base64').replace(/(.{20})/g, '$1\n');
    expect(readSharedFreeze({ board: '/x', branch: 'ops/b', readsSource: 'api', slug: 'o/r', rest: routes(fileWorld(SHARED_FREEZE_FILE, { ...b64(FREEZE), content: good })) })).toMatchObject({ frozen: true });
  });
  it('corrupt added-card content is held, not admitted', () => {
    const rest = routes({
      'compare/': ok({ files: [{ filename: 'backlog/xabc123-new.md', status: 'added' }] }),
      ...fileWorld('backlog/xabc123-new.md', { type: 'file', encoding: 'base64', content: '!!!!', sha: 'c'.repeat(40) }),
      'git/ref/heads/main': ok({ object: { sha: OTHER } }),
    });
    const r = checkBornAsCollision({ exec: () => `${OTHER}\n`, headSha: SHA, readsSource: 'api', rest, slug: 'o/r' });
    expect(r.ok).toBeUndefined();
    expect(r.error).toContain('invalid base64');
  });
  it('the freeze read keeps its 20 s bound', () => {
    const seen = [];
    const rest = (path, o) => { seen.push(o.execOpts.timeout); return ok(b64(FREEZE)); };
    readSharedFreeze({ board: '/x', branch: 'ops/b', readsSource: 'api', slug: 'o/r', rest });
    expect(seen).toEqual([20000]);
  });
});


/** R551/R552: one typed reader. Every result is {ok,value|reason,fetchedAt}; unreadable is never empty/0/false. */
const gitBlobSha = (text) => { const b = Buffer.from(text); return createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex'); };
const file = (text, over = {}) => ({ type: 'file', encoding: 'base64', size: Buffer.byteLength(text), sha: gitBlobSha(text), content: Buffer.from(text).toString('base64'), ...over });
const NOW = 1_700_000_000_000;
const src = (rest, o = {}) => createRestSource({ rest, slug: 'o/r', now: () => NOW, env: {}, ...o });

describe('injectable source interface (R552): read(kind, key) -> {ok, value, fetchedAt}', () => {
  it('a custom source backs every reader and its fetchedAt passes through', () => {
    const seen = [];
    const source = { read: (kind, key) => { seen.push([kind, key]); return { ok: true, value: { object: { sha: SHA } }, fetchedAt: 42 }; } };
    expect(readBranchSha('main', { source })).toMatchObject({ ok: true, value: SHA, fetchedAt: 42 });
    expect(seen).toEqual([['json', 'repos/{owner}/{repo}/git/ref/heads/main']]);
  });
  it('a source that reports unreadable is passed through, not turned into a value', () => {
    const source = { read: () => ({ ok: false, reason: 'snapshot-stale', fetchedAt: 7 }) };
    expect(readBranchSha('main', { source })).toMatchObject({ ok: false, reason: 'snapshot-stale', fetchedAt: 7 });
  });
  it('a source that returns a malformed result is itself unreadable', () => {
    expect(readBranchSha('main', { source: { read: () => ({ value: {} }) } })).toMatchObject({ ok: false, reason: 'source-malformed' });
    expect(readBranchSha('main', { source: { read: () => { throw new Error('boom'); } } })).toMatchObject({ ok: false, reason: 'source-error' });
  });
  it('fetchedAt is on every result, ok or not', () => {
    const good = readBranchSha('main', { source: src(routes({ 'git/ref/heads/main': ok({ object: { sha: SHA } }) })) });
    const bad = readBranchSha('main', { source: src(routes({ 'git/ref/heads/main': http(502) })) });
    expect(good).toMatchObject({ ok: true, fetchedAt: NOW });
    expect(bad).toMatchObject({ ok: false, reason: 'api-http-502', fetchedAt: NOW });
  });
  it('unwrap throws a named transient error on unreadable and returns the value otherwise', () => {
    expect(unwrap({ ok: true, value: 5, read: 'x' })).toBe(5);
    expect(() => unwrap({ ok: false, reason: 'api-http-502', read: 'branch-tip' })).toThrow(new RegExp(`${DRAIN_READ_TRANSIENT} \\(branch-tip: api-http-502\\)`));
  });
});

describe('pinned target: host and repository', () => {
  it.each([
    ['absolute URL to another host', 'https://evil.example/repos/o/r/x'],
    ['another host in the path', 'repos/{owner}/{repo}/../../../user'],
    ['no repos/ prefix', 'user/repos'],
    ['a protocol-relative URL', '//evil.example/x'],
  ])('rejects %s before any call', (_n, path) => {
    const rest = routes({ x: ok({}) });
    expect(src(rest).read('json', path)).toMatchObject({ ok: false, reason: 'path-not-pinned', fetchedAt: NOW });
    expect(rest.seen).toEqual([]);
  });
  it('forces github.com and drops GH_REPO / GH_HOST from the gh environment', () => {
    let seen;
    const rest = (path, o) => { seen = { path, o }; return ok({ a: 1 }); };
    src(rest, { env: { GH_HOST: 'ghe.evil.example', GH_REPO: 'evil/other', GH_ENTERPRISE_TOKEN: 't', HOME: '/h' } }).read('json', 'repos/{owner}/{repo}/git/ref/heads/main');
    expect(seen.path).toBe('repos/o/r/git/ref/heads/main');
    for (const env of [seen.o.env, seen.o.execOpts.env]) {
      expect(env.GH_HOST).toBe('github.com');
      expect(env.GH_REPO).toBeUndefined();
      expect(env.GH_ENTERPRISE_TOKEN).toBeUndefined();
    }
  });
  it('an unpinnable origin is unreadable with a reason, not a throw', () => {
    const r = createRestSource({ rest: routes({}), cwd: `/c-${Math.random()}`, env: {}, git: () => 'https://gitlab.com/a/b', now: () => NOW }).read('json', 'repos/{owner}/{repo}/x');
    expect(r).toMatchObject({ ok: false, reason: 'origin-unparseable', fetchedAt: NOW });
  });
  it('a configured repo that is not the origin repo is unreadable', () => {
    const r = createRestSource({ rest: routes({}), cwd: `/c-${Math.random()}`, env: {}, repo: 'x/y', git: () => 'git@github.com:a/b.git', now: () => NOW }).read('json', 'repos/{owner}/{repo}/x');
    expect(r).toMatchObject({ ok: false, reason: 'repo-mismatch' });
  });
});

describe('complete file-status set for added files', () => {
  const read = (files) => readAddedFiles('main', SHA, { source: src(routes({ 'compare/': ok({ files }) })) });
  it.each([
    ['added', { filename: 'backlog/a.md', status: 'added' }, ['backlog/a.md'], []],
    ['modified', { filename: 'backlog/a.md', status: 'modified' }, [], []],
    ['removed', { filename: 'backlog/a.md', status: 'removed' }, [], []],
    ['changed', { filename: 'backlog/a.md', status: 'changed' }, [], []],
    ['unchanged', { filename: 'backlog/a.md', status: 'unchanged' }, [], []],
    ['renamed into backlog/', { filename: 'backlog/a.md', previous_filename: 'drafts/a.md', status: 'renamed' }, ['backlog/a.md'], ['drafts/a.md']],
    ['renamed out of backlog/', { filename: 'archive/a.md', previous_filename: 'backlog/a.md', status: 'renamed' }, ['archive/a.md'], ['backlog/a.md']],
    ['copied into backlog/', { filename: 'backlog/b.md', previous_filename: 'backlog/a.md', status: 'copied' }, ['backlog/b.md'], ['backlog/a.md']],
  ])('%s', (_n, entry, added, previous) => {
    expect(read([entry])).toMatchObject({ ok: true, value: { added, previous } });
  });
  it.each([
    ['unknown status', { filename: 'backlog/a.md', status: 'weird' }],
    ['no status', { filename: 'backlog/a.md' }],
    ['no filename', { status: 'added' }],
    ['renamed without previous_filename', { filename: 'backlog/a.md', status: 'renamed' }],
    ['copied without previous_filename', { filename: 'backlog/a.md', status: 'copied' }],
    ['non-string previous_filename', { filename: 'backlog/a.md', previous_filename: 5, status: 'renamed' }],
  ])('%s is unreadable, never skipped', (_n, entry) => {
    expect(read([{ filename: 'x', status: 'modified' }, entry])).toMatchObject({ ok: false, reason: 'api-malformed' });
  });
});

describe('verified decode: base64 against reported size and sha', () => {
  const T = 'hello\nworld\n';
  const at = (doc) => readFileAtRef('t', 'a/b.md', 'main', { source: src(routes(fileWorld('a/b.md', doc))) });
  it('a matching size and sha decodes', () => { expect(at(file(T))).toMatchObject({ ok: true, value: T }); });
  it('an absent path (404) is a real, ok null', () => {
    expect(readFileAtRef('t', 'a/b.md', 'main', { source: src(routes({ 'git/commits/': ok({ tree: { sha: 'rt0' } }), 'git/trees/rt0': ok({ tree: [{ path: 'a', type: 'tree', sha: 'rt1' }] }), 'git/trees/rt1': ok({ tree: [] }) })) })).toMatchObject({ ok: true, value: null });
  });
  it.each([
    ['size too small', file(T, { size: 3 }), 'size'],
    ['size too large', file(T, { size: 9999 }), 'size'],
    ['size missing', file(T, { size: undefined }), 'size'],
    ['sha mismatch', file(T, { sha: 'f'.repeat(40) }), 'sha'],
    ['sha missing', file(T, { sha: undefined }), 'sha'],
    ['content truncated but still valid base64', file(T, { content: Buffer.from(T.slice(0, 4)).toString('base64') }), 'size'],
    ['encoding none (over 1 MB)', file(T, { encoding: 'none', content: '' }), 'base64 file'],
    ['not a file', { type: 'dir' }, 'base64 file'],
  ])('%s is unreadable', (_n, doc, why) => {
    const r = at(doc);
    expect(r).toMatchObject({ ok: false, reason: 'api-malformed' });
    expect(r.detail).toContain(why);
  });
});

describe('pagination: follow to the end or be unreadable', () => {
  const page = (n, status = 'modified') => Array.from({ length: n }, (_x, i) => ({ filename: `f${i}-${n}-${Math.random()}`, status }));
  it('follows pages until a short page and concatenates every page', () => {
    const rest = routes({ '&page=1': ok({ files: [...page(99), { filename: 'backlog/a.md', status: 'added' }] }), '&page=2': ok({ files: [{ filename: 'backlog/b.md', status: 'added' }] }) });
    const r = readAddedFiles('main', SHA, { source: src(rest) });
    expect(r).toMatchObject({ ok: true, value: { added: ['backlog/a.md', 'backlog/b.md'] } });
    expect(rest.seen).toHaveLength(3); // base-tip read + two pages
  });
  it('a page failing midway makes the whole read unreadable, not a partial list', () => {
    const rest = routes({ '&page=1': ok({ files: page(100) }), '&page=2': http(502) });
    expect(readAddedFiles('main', SHA, { source: src(rest) })).toMatchObject({ ok: false, reason: 'api-http-502' });
  });
  it('the compare lists at most 300 files with no truncation flag: 300 files then an empty page is compare-ceiling, never complete', () => {
    const rest = routes({ '&page=1': ok({ files: page(100) }), '&page=2': ok({ files: page(100) }), '&page=3': ok({ files: page(100) }), '&page=4': ok({ files: [] }) });
    expect(readAddedFiles('main', SHA, { source: src(rest) })).toMatchObject({ ok: false, reason: 'compare-ceiling' });
  });
  it('299 files are complete; 300 in one page is compare-ceiling', () => {
    const one = (n) => readAddedFiles('main', SHA, { source: src(routes({ 'compare/': ok({ files: page(n) }) })) });
    expect(one(299)).toMatchObject({ ok: true });
    expect(one(300)).toMatchObject({ ok: false, reason: 'compare-ceiling' });
  });
  it('a tree flagged truncated is unreadable', () => {
    const rest = routes(hwWorld([], { bk: ok({ tree: [], truncated: true }) }));
    expect(readBacklogNames('main', { source: src(rest) })).toMatchObject({ ok: false, reason: 'api-truncated' });
  });
  it('a missing files list is unreadable', () => {
    expect(readAddedFiles('main', SHA, { source: src(routes({ 'compare/': ok({ nope: 1 }) })) })).toMatchObject({ ok: false, reason: 'api-malformed' });
  });
});

describe('bounded calls: per-call deadline through the throttled reader', () => {
  it('passes a per-call timeout (default 20 s, overridable) to the exec options', () => {
    const seen = [];
    const rest = (_p, o) => { seen.push(o.execOpts.timeout); return ok({ a: 1 }); };
    src(rest).read('json', 'repos/{owner}/{repo}/x');
    src(rest, { timeoutMs: 5000 }).read('json', 'repos/{owner}/{repo}/x');
    expect(seen).toEqual([20000, 5000]);
  });
  it('an exec timeout is the named reason deadline', () => {
    const rest = () => { throw Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT' }); };
    expect(src(rest).read('json', 'repos/{owner}/{repo}/x')).toMatchObject({ ok: false, reason: 'deadline' });
  });
  it('a read started past the overall deadline makes no call and is unreadable', () => {
    const rest = routes({ x: ok({}) });
    expect(src(rest, { deadlineAt: NOW - 1 }).read('json', 'repos/{owner}/{repo}/x')).toMatchObject({ ok: false, reason: 'deadline' });
    expect(rest.seen).toEqual([]);
  });
  it('a paged read stops with deadline once the overall deadline passes mid-way', () => {
    let t = NOW;
    const rest = (p) => { t += 10; if (p.includes('git/ref/heads/')) return ok({ object: { sha: SHA } }); return ok({ files: Array.from({ length: 100 }, (_x, i) => ({ filename: `f${i}-${t}`, status: 'modified' })) }); };
    const r = readAddedFiles('main', SHA, { source: createRestSource({ rest, slug: 'o/r', env: {}, now: () => t, deadlineAt: NOW + 25 }) });
    expect(r).toMatchObject({ ok: false, reason: 'deadline' });
  });
  it('goes through gh-throttle: the default transport is the throttled ETag reader', () => {
    const rest = (_p, o) => { expect(o.execOpts.throttle).toBeUndefined(); return ok({}); };
    expect(src(rest).read('json', 'repos/{owner}/{repo}/x').ok).toBe(true);
  });
});

describe('callers fail closed on unreadable (no empty/0/false mapping)', () => {
  it('freeze: unreadable is an error with no frozen flag', () => {
    const r = readSharedFreeze({ board: '/x', branch: 'ops/b', readsSource: 'api', slug: 'o/r', rest: routes({ [SHARED_FREEZE_FILE]: http(503) }) });
    expect(r).toMatchObject({ transient: true }); expect(r.frozen).toBeUndefined();
  });
  it('bornAs: a renamed card into backlog/ with an unreadable body is held', () => {
    const rest = routes({
      'compare/': ok({ files: [{ filename: 'backlog/xabc123-new.md', previous_filename: 'd/x.md', status: 'renamed' }] }),
      ...fileWorld('backlog/xabc123-new.md', file('---\nbornAs: xabc123\n---\n', { size: 1 })),
      'git/ref/heads/main': ok({ object: { sha: OTHER } }),
    });
    const r = checkBornAsCollision({ exec: () => `${OTHER}\n`, headSha: SHA, readsSource: 'api', rest, slug: 'o/r' });
    expect(r.ok).toBeUndefined();
    expect(r.error).toContain('api-malformed');
  });
  it('bornAs: a copied card is checked at its new path', () => {
    const rest = routes({
      'compare/': ok({ files: [{ filename: 'backlog/xabc123-new.md', previous_filename: 'backlog/old.md', status: 'copied' }] }),
      ...fileWorld('backlog/xabc123-new.md', file('---\nbornAs: xabc123\n---\n')),
      'git/ref/heads/main': ok({ object: { sha: OTHER } }),
    });
    const calls = [];
    const exec = (_c, a) => { calls.push(a[0]); if (a[0] === 'rev-parse') return `${OTHER}\n`; if (a[0] === 'grep') throw Object.assign(new Error('none'), { status: 1 }); throw new Error('unexpected'); };
    expect(checkBornAsCollision({ exec, headSha: SHA, readsSource: 'api', rest, slug: 'o/r' })).toEqual({ ok: true });
    expect(calls).toContain('grep');
  });
});

describe('the pinned repository is the one of the requested remote', () => {
  it('derives the slug from the named remote, not always origin', () => {
    const asked = [];
    const git = (_c) => 'git@github.com:up/stream.git';
    expect(readOriginSlug(`/c-${Math.random()}`, { remote: 'upstream', git: (c) => { asked.push(c); return git(c); } })).toBe('up/stream');
    expect(() => readOriginSlug(`/c-${Math.random()}`, { remote: '--upload-pack=x y', git })).toThrow(/origin-unreadable/);
  });
  it('the allocator reads the high-water mark of the requested remote repo, never origin', () => {
    const dir = mkdtempSync(join(tmpdir(), 'remotes-'));
    for (const a of [['init', '-q'], ['remote', 'add', 'origin', 'git@github.com:fork/repo.git'], ['remote', 'add', 'upstream', 'git@github.com:up/repo.git']]) execFileSync('git', ['-C', dir, ...a]);
    const seen = [];
    const table = routes(hwWorld(['7-a.md']));
    const rest = (path, o) => { seen.push(path); return table(path, o); };
    const git = (args) => (args[0] === 'ls-remote' ? '' : `${dir}\n`);
    expect(readNumberingEvidence(git, 'upstream', { source: 'api', rest, cwd: dir }).main).toEqual([7]);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((p) => p.startsWith('repos/up/repo/'))).toBe(true);
  });
});

describe('R557 one snapshot: every multi-part read resolves ONE commit sha first', () => {
  const MOVED = 'c'.repeat(40);
  /** main is at SHA on the first ref read and at MOVED afterwards; each commit has its own tree. */
  const movingMain = () => {
    let n = 0;
    const rest = routes({
      'git/ref/heads/main': () => { n += 1; return ok({ object: { sha: n === 1 ? SHA : MOVED } }); },
      [`git/commits/${SHA}`]: ok({ tree: { sha: 'rt0' } }),
      [`git/commits/${MOVED}`]: ok({ tree: { sha: 'rtMoved' } }),
      'git/trees/rt0': ok({ tree: [{ path: 'backlog', type: 'tree', sha: 'bk' }] }),
      'git/trees/rtMoved': ok({ tree: [{ path: 'backlog', type: 'tree', sha: 'bkMoved' }] }),
      'git/trees/bk': ok({ tree: [{ path: '5-old.md', type: 'blob', mode: '100644' }] }),
      'git/trees/bkMoved': ok({ tree: [{ path: '9-new.md', type: 'blob', mode: '100644' }] }),
    });
    return rest;
  };
  it('the high-water read names the commit it read, and reads trees only through that commit', () => {
    const rest = movingMain();
    const r = readBacklogNames('main', { source: src(rest) });
    expect(r).toMatchObject({ ok: true, value: ['backlog/5-old.md'], sha: SHA });
    expect(rest.seen.filter((p) => p.includes('git/ref/heads/main'))).toHaveLength(1); // the tip is read once
    expect(rest.seen.some((p) => p.includes(MOVED) || p.includes('rtMoved'))).toBe(false);
  });
  it('allocator: main moving between reads cannot pair the older floor with the newer tracking ref', () => {
    const rest = movingMain();
    const git = (args) => { if (args[0] === 'rev-parse') return `${MOVED}\n`; if (args[0] === 'ls-remote') return ''; throw new Error('fetch ETIMEDOUT'); };
    // The local ref already equals the NEWER tip, but the floor came from the OLDER commit: that pairing must be refused.
    expect(() => readNumberingEvidence(git, 'origin', { source: 'api', rest, cwd: '/c', slug: 'o/r', refreshTracking: true })).toThrow(/tracking-ref-stale/);
  });
  it('bornAs: the comparison base is pinned to one sha, and the tip compared is that same sha', () => {
    let n = 0;
    const rest = routes({
      'git/ref/heads/main': () => { n += 1; return ok({ object: { sha: n === 1 ? OTHER : MOVED } }); },
      'compare/': ok({ files: [{ filename: 'backlog/xabc123-new.md', status: 'added' }] }),
      ...fileWorld('backlog/xabc123-new.md', b64('---\nbornAs: xabc123\n---\n')),
    });
    const git = (a) => { if (a[0] === 'rev-parse') return `${OTHER}\n`; if (a[0] === 'grep') throw Object.assign(new Error('none'), { status: 1 }); throw new Error('unexpected'); };
    expect(checkBornAsCollision({ exec: (_c, a) => git(a), headSha: SHA, readsSource: 'api', rest, slug: 'o/r' })).toEqual({ ok: true });
    expect(rest.seen.find((p) => p.includes('compare/'))).toContain(`${OTHER}...${SHA}`);
    expect(rest.seen.filter((p) => p.includes('git/ref/heads/main'))).toHaveLength(1);
  });
  it('a file read resolves the ref once and fetches contents at that sha', () => {
    const rest = routes({ ...fileWorld('a/b.md', b64('x\n')), 'git/ref/heads/main': () => ok({ object: { sha: SHA } }) });
    expect(readFileAtRef('t', 'a/b.md', 'main', { source: src(rest) })).toMatchObject({ ok: true, value: 'x\n', sha: SHA });
    expect(rest.seen.at(-1)).toContain(`?ref=${SHA}`);
  });
});

describe('R557 only regular files read: tree entry mode and blob identity', () => {
  const T = 'frozen\n';
  const at = (entry, over = {}) => readFileAtRef('t', 'a/b.md', 'main', { source: src(routes(fileWorld('a/b.md', b64(T), { entry, ...over }))) });
  it.each([['100644'], ['100755']])('mode %s is read', (mode) => {
    expect(at({ mode })).toMatchObject({ ok: true, value: T });
  });
  it.each([
    ['symlink 120000', { mode: '120000' }],
    ['submodule 160000', { mode: '160000', type: 'commit' }],
    ['a tree 040000', { mode: '040000', type: 'tree' }],
    ['group-writable legacy 100664', { mode: '100664' }],
    ['no mode', { mode: undefined }],
    ['mode as a number', { mode: 100644 }],
  ])('%s is unreadable', (_n, entry) => {
    expect(at(entry)).toMatchObject({ ok: false, reason: 'api-malformed' });
  });
  it('a symlink whose target content verifies still cannot be read (the Contents API dereferences it)', () => {
    const r = at({ mode: '120000' });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('not a regular file');
  });
  it('contents whose sha differs from the tree entry is unreadable', () => {
    expect(at({ sha: 'd'.repeat(40) })).toMatchObject({ ok: false, reason: 'api-malformed' });
  });
  it('a directory component that is itself a symlink or file is unreadable', () => {
    const rest = routes({ ...fileWorld('a/b.md', b64(T)), 'git/trees/rt0': ok({ tree: [{ path: 'a', type: 'blob', mode: '120000', sha: 'rt1' }] }) });
    expect(readFileAtRef('t', 'a/b.md', 'main', { source: src(rest) })).toMatchObject({ ok: false, reason: 'api-malformed' });
  });
  it('freeze read: a symlinked freeze document holds (fail closed) even with valid target JSON', () => {
    const rest = routes(fileWorld(SHARED_FREEZE_FILE, b64('{"frozen":false}'), { entry: { mode: '120000' } }));
    const r = readSharedFreeze({ board: '/x', branch: 'ops/b', readsSource: 'api', slug: 'o/r', rest });
    expect(r.frozen).toBeUndefined();
    expect(r.error).toContain('not a regular file');
  });
});
