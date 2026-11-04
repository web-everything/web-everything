// @vitest-environment node
/**
 * @file drain-api-reads.test.mjs - R515/R546: the drain's freeze, high-water-mark and bornAs reads go through
 *   GitHub REST + ETag (setting drain.reads.source), fail CLOSED with a named transient reason, never fall back to git.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ghRestGetJson } from '../gh-rest-read.mjs';
import { DRAIN_READ_TRANSIENT, DrainReadError, isTransientReadFailure, resolveDrainReadsSource } from '../drain-api-reads.mjs';
import { readSharedFreeze, SHARED_FREEZE_FILE } from '../red-main-freeze-shared.mjs';
import { readNumberingEvidence } from '../card-number-allocator.mjs';
import { checkBornAsCollision, guardEnqueue } from '../drain-poison-guard.mjs';
import { finishBranchPreparation } from '../queue-branch-numbering.mjs';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const b64 = (text) => ({ type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64') });
const ok = (json) => ({ status: 200, json, notModified: false });
const http = (status) => Object.assign(new Error(`gh: HTTP ${status}`), { httpStatus: status });
/** A REST fake keyed by path substring; a function value throws/returns per call. */
const routes = (table) => { const seen = []; const rest = (path) => {
  seen.push(path);
  const hit = Object.keys(table).find((k) => path.includes(k));
  if (!hit) throw http(404);
  const v = typeof table[hit] === 'function' ? table[hit](path) : table[hit];
  if (v instanceof Error) throw v;
  return v;
}; rest.seen = seen; return rest; };
const noGit = (calls = []) => (...a) => { calls.push(a); throw new Error('git must not run'); };
const FREEZE = JSON.stringify({ frozen: true, kind: 'manual', reason: 'r', at: 't' });

describe('drain.reads.source setting', () => {
  it('defaults to api, takes tool setting and env, ignores junk', () => {
    expect(resolveDrainReadsSource({ env: {}, file: {}, platform: {} })).toMatchObject({ value: 'api', source: 'default' });
    expect(resolveDrainReadsSource({ env: {}, file: { drain: { reads: { source: 'git' } } }, platform: {} })).toMatchObject({ value: 'git', source: 'settings' });
    expect(resolveDrainReadsSource({ env: { WE_DRAIN_READS_SOURCE: 'git' }, file: {}, platform: {} }).value).toBe('git');
    expect(resolveDrainReadsSource({ env: { WE_DRAIN_READS_SOURCE: 'bogus' }, file: {}, platform: {} }).value).toBe('api');
  });
});

describe('freeze read over REST', () => {
  const read = (rest) => readSharedFreeze({ board: '/x', branch: 'ops/red-main-freeze', readsSource: 'api', rest });
  it('success: parses the doc without a git process', () => {
    const rest = routes({ [SHARED_FREEZE_FILE]: ok(b64(FREEZE)) });
    expect(read(rest)).toMatchObject({ frozen: true, kind: 'manual' });
    expect(rest.seen[0]).toContain('ref=ops%2Fred-main-freeze');
  });
  it('304: the ETag reader serves the cached body', () => {
    const rest = routes({ [SHARED_FREEZE_FILE]: { status: 304, notModified: true, json: b64(FREEZE) } });
    expect(read(rest)).toMatchObject({ frozen: true });
  });
  it('real ETag reader: second call is a conditional 304 that costs no refetch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'etag-'));
    let n = 0;
    const exec = (cmd, argv) => {
      if (argv[0] === 'api' && argv.includes('If-None-Match: "e1"')) throw Object.assign(new Error('gh: HTTP 304'), { stdout: 'HTTP/2.0 304 Not Modified\r\netag: "e1"\r\n\r\n', stderr: 'gh: HTTP 304' });
      n += 1;
      return `HTTP/2.0 200 OK\r\netag: "e1"\r\n\r\n${JSON.stringify(b64(FREEZE))}`;
    };
    const rest = (path, o) => ghRestGetJson(path, { ...o, exec, dir, env: { ...o.env, WE_GH_ETAG_CACHE: '1' } });
    expect(read(rest)).toMatchObject({ frozen: true });
    expect(read(rest)).toMatchObject({ frozen: true });
    expect(n).toBe(1);
  });
  it('5xx: fails closed with a named transient reason', () => {
    const r = read(routes({ [SHARED_FREEZE_FILE]: http(502) }));
    expect(r.frozen).toBeUndefined();
    expect(r.transient).toBe(true);
    expect(r.error).toContain('api-http-502');
    expect(isTransientReadFailure(r.error)).toBe(true);
  });
  it('malformed response fails closed', () => {
    expect(read(routes({ [SHARED_FREEZE_FILE]: ok({ type: 'dir' }) })).error).toContain('api-malformed');
    expect(read(routes({ [SHARED_FREEZE_FILE]: ok(b64('not json')) })).error).toContain('not JSON');
  });
});

describe('origin/main high-water mark over REST', () => {
  const tree = (names, extra = {}) => ({ tree: names.map((path) => ({ path, type: 'blob' })), ...extra });
  const base = (over = {}) => routes({
    'git/trees/main': ok({ tree: [{ path: 'backlog', type: 'tree', sha: 'bk' }] }),
    'git/trees/bk': ok(tree(['100-a.md', '7-b.md', 'README.md'])),
    ...over,
  });
  const run = (rest, git = noGit()) => readNumberingEvidence(git, 'origin', { source: 'api', rest });
  const refsGit = (calls) => (args) => { calls.push(args); if (args[0] === 'ls-remote') return ''; throw new Error('only ls-remote allowed'); };
  it('success: max card number from the REST tree, no fetch/ls-tree', () => {
    const calls = [];
    expect(Math.max(...run(base(), refsGit(calls)).main)).toBe(100);
    expect(calls.map((c) => c[0])).toEqual(['ls-remote']);
  });
  it('304 path: cached trees are used as-is', () => {
    const rest = routes({
      'git/trees/main': { status: 304, notModified: true, json: { tree: [{ path: 'backlog', type: 'tree', sha: 'bk' }] } },
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
    expect(() => run(base({ 'git/trees/main': ok({ tree: [] }) }))).toThrow(/api-malformed/);
  });
  it('refreshTracking: stale local ref after a failed fetch fails closed; a current ref needs no fetch', () => {
    const rest = base({ 'git/ref/heads/main': ok({ object: { sha: SHA } }) });
    const git = (local, calls) => (args) => { calls.push(args[0]); if (args[0] === 'rev-parse') return `${local}\n`; if (args[0] === 'ls-remote') return ''; throw new Error('fetch ETIMEDOUT'); };
    const stale = [];
    expect(() => readNumberingEvidence(git(OTHER, stale), 'origin', { source: 'api', rest, refreshTracking: true })).toThrow(/tracking-ref-stale/);
    const fresh = [];
    readNumberingEvidence(git(SHA, fresh), 'origin', { source: 'api', rest, refreshTracking: true });
    expect(fresh).not.toContain('fetch');
  });
});

describe('bornAs read over REST', () => {
  const CARD = '---\nbornAs: xabc123\n---\nbody\n';
  const args = (rest, git) => ({ exec: (cmd, a) => git(a), headSha: SHA, cwd: undefined, readsSource: 'api', rest });
  const rest0 = (over = {}) => routes({
    'compare/': ok({ files: [{ filename: 'backlog/xabc123-new.md', status: 'added' }, { filename: 'src/x.ts', status: 'added' }] }),
    'contents/backlog/xabc123-new.md': ok(b64(CARD)),
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
    const out = guardEnqueue({ c: { num: 9 }, headSha: SHA, repo: 'o/r', exec: (c, a) => git()(a), base: 'main', readsSource: 'api', rest: rest0({ 'compare/': http(500) }) });
    expect(out).toMatchObject({ enqueued: false, deferred: true, kind: 'bornas-unreadable' });
    expect(out.reason).toContain('Retry note');
    expect(out.reason).not.toContain('Inspect main');
  });
  it('malformed or truncated responses fail closed', () => {
    expect(checkBornAsCollision(args(rest0({ 'compare/': ok({ nope: 1 }) }), git())).error).toContain('api-malformed');
    expect(checkBornAsCollision(args(rest0({ 'compare/': ok({ files: new Array(300).fill({ filename: 'a', status: 'modified' }) }) }), git())).error).toContain('api-truncated');
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
