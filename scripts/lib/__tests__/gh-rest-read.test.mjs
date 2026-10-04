/**
 * @file scripts/lib/__tests__/gh-rest-read.test.mjs
 * @description #4351 — reads move off GraphQL onto REST with ETag conditional requests. Proves: `gh api -i`
 *   output parses (CRLF headers, bare fake bodies, 304s); a repeat GET sends `If-None-Match` and a 304 is served
 *   from the on-disk cache; any non-304 failure is re-thrown unchanged; a response without an ETag is never
 *   cached; paging stops on a short page / `maxItems`; the REST `pulls` item maps to exactly what
 *   `gh pr list --json number,state,title,headRefName,body` returned (a live-captured fixture pair); and
 *   `lane-whois#fetchAllPrs`, through the REAL throttle + a PATH-faked `gh`, spends only the `core` bucket and
 *   logs a `not_modified` hit on the repeat — the shape `gh-spend.mjs report --by=caller+op` reads.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseGhApiIncludeOutput, ghRestGetJson, ghRestGetPaged, ghEtagCacheEnabled, etagCachePath,
} from '../gh-rest-read.mjs';
import { restPullToListShape, fetchAllPrs } from '../../lane-whois.mjs';
import { rollupSpend, summarizeSpendRows } from '../gh-spend.mjs';

const FIXTURE = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'gh-pulls-rest-vs-graphql.json'), 'utf8'));
const ok = (body, etag = 'W/"e1"') => `HTTP/2.0 200 OK\r\n${etag ? `Etag: ${etag}\r\n` : ''}X-Ratelimit-Resource: core\r\n\r\n${body}`;
const notModified = () => Object.assign(new Error('gh: HTTP 304'), { status: 1, stdout: 'HTTP/2.0 304 Not Modified\r\nEtag: "e1"\r\n\r\n', stderr: 'gh: HTTP 304\n' });

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gh-rest-read-')); });

describe('parseGhApiIncludeOutput', () => {
  it('splits status, lower-cased headers and body', () => {
    const r = parseGhApiIncludeOutput(ok('[1,2]'));
    expect(r).toEqual({ status: 200, headers: { etag: 'W/"e1"', 'x-ratelimit-resource': 'core' }, body: '[1,2]' });
  });
  it('reads a 304 with no body', () => {
    expect(parseGhApiIncludeOutput(notModified().stdout).status).toBe(304);
  });
  it('treats output with no status line (a PATH-faked gh) as a bare 200 body', () => {
    expect(parseGhApiIncludeOutput('[]\n')).toEqual({ status: 200, headers: {}, body: '[]\n' });
    expect(parseGhApiIncludeOutput(undefined)).toEqual({ status: 200, headers: {}, body: '' });
  });
});

describe('ghRestGetJson — conditional requests', () => {
  function scripted(responses) {
    const calls = [];
    const exec = (file, argv, opts) => {
      calls.push({ argv, opts });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    };
    return { exec, calls };
  }
  const o = (exec, extra = {}) => ({ exec, dir, env: { VITEST: '1' }, ...extra });

  it('first GET is unconditional; the repeat sends If-None-Match and a 304 serves the cached body', () => {
    const { exec, calls } = scripted([ok('{"a":1}'), notModified()]);
    const first = ghRestGetJson('repos/o/r/pulls/1', o(exec));
    expect(first).toEqual({ status: 200, json: { a: 1 }, etag: 'W/"e1"', notModified: false });
    expect(calls[0].argv).toEqual(['api', '-i', 'repos/o/r/pulls/1']);
    expect(calls[0].opts.throttle.op).toBe('rest pulls/1');
    const again = ghRestGetJson('repos/o/r/pulls/1', o(exec));
    expect(calls[1].argv).toEqual(['api', '-i', '-H', 'If-None-Match: W/"e1"', 'repos/o/r/pulls/1']);
    expect(again).toEqual({ status: 304, json: { a: 1 }, etag: 'W/"e1"', notModified: true });
  });

  it('a changed resource (200 after a cached ETag) replaces the cache', () => {
    const { exec } = scripted([ok('{"a":1}'), ok('{"a":2}', 'W/"e2"'), notModified()]);
    ghRestGetJson('p', o(exec));
    expect(ghRestGetJson('p', o(exec)).json).toEqual({ a: 2 });
    expect(ghRestGetJson('p', o(exec))).toMatchObject({ status: 304, json: { a: 2 }, etag: 'W/"e2"' });
  });

  it('re-throws any non-304 failure unchanged (the runGhSync contract)', () => {
    const boom = Object.assign(new Error('gh: Not Found (HTTP 404)'), { status: 1, stdout: 'HTTP/2.0 404 Not Found\r\n\r\n{}', stderr: 'gh: Not Found (HTTP 404)' });
    const { exec } = scripted([boom]);
    expect(() => ghRestGetJson('p', o(exec))).toThrow(boom);
    const bare = new Error('spawn gh ENOENT');
    expect(() => ghRestGetJson('p', o(scripted([bare]).exec))).toThrow(bare);
  });

  it('a 304 to an UNCONDITIONAL request is not served from a cache it never consulted', () => {
    const { exec } = scripted([notModified()]);
    expect(() => ghRestGetJson('p', o(exec))).toThrow('gh: HTTP 304');
  });

  it('never caches a response that carried no ETag', () => {
    const { exec, calls } = scripted([ok('[]', null), ok('[]', null)]);
    ghRestGetJson('p', o(exec));
    ghRestGetJson('p', o(exec));
    expect(calls[1].argv).not.toContain('-H');
  });

  it('keys the cache by identity and context, so an App-token entry never answers a personal-token read', () => {
    const { exec, calls } = scripted([ok('[1]'), ok('[2]', 'W/"e2"'), ok('[3]', 'W/"e3"')]);
    ghRestGetJson('repos/{owner}/{repo}/pulls', o(exec, { context: '/a' }));
    ghRestGetJson('repos/{owner}/{repo}/pulls', o(exec, { context: '/b' }));
    ghRestGetJson('repos/{owner}/{repo}/pulls', o(exec, { context: '/a', execOpts: { env: { GH_TOKEN: 'ghs_x' } } }));
    expect(calls.every((c) => !c.argv.includes('-H'))).toBe(true);
    expect(etagCachePath(dir, { path: 'p', identity: 'app' })).not.toBe(etagCachePath(dir, { path: 'p', identity: 'default' }));
  });

  it('is disabled (plain GETs, nothing written) under vitest with no dir, or with WE_GH_ETAG_CACHE=0', () => {
    expect(ghEtagCacheEnabled({ VITEST: '1' })).toBe(false);
    expect(ghEtagCacheEnabled({ WE_GH_ETAG_CACHE: '0', WE_GH_ETAG_DIR: dir })).toBe(false);
    expect(ghEtagCacheEnabled({ VITEST: '1', WE_GH_ETAG_DIR: dir })).toBe(true);
    const { exec, calls } = scripted([ok('[]'), ok('[]')]);
    ghRestGetJson('p', { exec, env: { VITEST: '1', HOME: dir } });
    ghRestGetJson('p', { exec, env: { VITEST: '1', HOME: dir } });
    expect(calls[1].argv).not.toContain('-H');
    expect(existsSync(join(dir, '.claude'))).toBe(false);
  });
});

describe('ghRestGetPaged', () => {
  it('walks page numbers until a short page, appending per_page/page to an existing query', () => {
    const pages = [[1, 2], [3, 4], [5]];
    const seen = [];
    const exec = (f, argv) => { seen.push(argv.at(-1)); return ok(JSON.stringify(pages.shift()), null); };
    expect(ghRestGetPaged('repos/o/r/pulls?state=all', { perPage: 2, exec, dir })).toEqual([1, 2, 3, 4, 5]);
    expect(seen).toEqual([
      'repos/o/r/pulls?state=all&per_page=2&page=1', 'repos/o/r/pulls?state=all&per_page=2&page=2', 'repos/o/r/pulls?state=all&per_page=2&page=3',
    ]);
  });
  it('stops at maxItems without fetching further pages', () => {
    let n = 0;
    const exec = () => { n += 1; return ok('[1,2]', null); };
    expect(ghRestGetPaged('p', { perPage: 2, maxItems: 3, exec, dir })).toEqual([1, 2, 1]);
    expect(n).toBe(2);
  });
  it('an empty first page is an empty list', () => {
    expect(ghRestGetPaged('p', { exec: () => '[]\n', dir })).toEqual([]);
  });
});

describe('lane-whois REST shape equals the old `gh pr list --json number,state,title,headRefName,body`', () => {
  it('matches the live-captured GraphQL answer for the same merged/open/closed PRs', () => {
    expect(FIXTURE.rest.map(restPullToListShape)).toEqual(FIXTURE.graphql);
    expect(new Set(FIXTURE.graphql.map((p) => p.state))).toEqual(new Set(['MERGED', 'OPEN', 'CLOSED']));
  });
  it('renders a null REST body as gh does ("")', () => {
    expect(restPullToListShape({ number: 1, state: 'open', title: 't', body: null, merged_at: null, head: { ref: 'x' } }).body).toBe('');
  });
});

describe('lane-whois#fetchAllPrs through the real throttle (PATH-faked gh)', () => {
  let saved;
  let lockRoot;
  let argvLog;
  beforeEach(() => {
    saved = { PATH: process.env.PATH, WE_GH_THROTTLE_LOCK_ROOT: process.env.WE_GH_THROTTLE_LOCK_ROOT, WE_GH_ETAG_DIR: process.env.WE_GH_ETAG_DIR };
    lockRoot = join(dir, 'lock');
    argvLog = join(dir, 'argv.log');
    const bin = mkdtempSync(join(tmpdir(), 'gh-rest-read-gh-'));
    writeFileSync(join(dir, 'body.json'), JSON.stringify(FIXTURE.rest));
    writeFileSync(join(bin, 'gh'), [
      '#!/bin/sh',
      `echo "$*" >> '${argvLog}'`,
      '[ "$1" = "pr" ] && { echo "graphql pr list must not run" >&2; exit 97; }',
      'case "$*" in *If-None-Match*) printf \'HTTP/2.0 304 Not Modified\\r\\nEtag: "e1"\\r\\n\\r\\n\'; echo "gh: HTTP 304" >&2; exit 1;; esac',
      'printf \'HTTP/2.0 200 OK\\r\\nEtag: W/"e1"\\r\\n\\r\\n\'',
      `cat '${join(dir, 'body.json')}'`,
      '',
    ].join('\n'));
    chmodSync(join(bin, 'gh'), 0o755);
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.WE_GH_THROTTLE_LOCK_ROOT = lockRoot;
    process.env.WE_GH_ETAG_DIR = join(dir, 'etag');
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  });

  it('returns the old shape, re-reads via a free 304, and spends only the core bucket', () => {
    const first = fetchAllPrs({ ghRepo: 'web-everything/web-everything' });
    const second = fetchAllPrs({ ghRepo: 'web-everything/web-everything' });
    expect(first).toEqual(FIXTURE.graphql);
    expect(second).toEqual(FIXTURE.graphql);

    const argv = readFileSync(argvLog, 'utf8').trim().split('\n');
    expect(argv).toEqual([
      'api -i repos/web-everything/web-everything/pulls?state=all&per_page=100&page=1',
      'api -i -H If-None-Match: W/"e1" repos/web-everything/web-everything/pulls?state=all&per_page=100&page=1',
    ]);
    expect(readdirSync(join(dir, 'etag'))).toHaveLength(1);

    const entries = readFileSync(join(lockRoot, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(entries.filter((e) => e.outcome === 'not_modified')).toHaveLength(1);
    const sections = summarizeSpendRows(rollupSpend(entries), { by: 'caller+op' });
    expect(sections.map((s) => s.resource)).toEqual(['core']);
    const row = sections[0].dims.find((d) => d.name.endsWith(' rest pulls (whois)'));
    expect(row.requests).toBe(2);
  });
});

describe('#4429 REST prevention boundaries', () => {
  it('private cache creation and replacements under permissive umask', () => {
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { ghRestGetJson } from ${JSON.stringify(join(process.cwd(), 'scripts/lib/gh-rest-read.mjs'))};
      import { statSync, readdirSync, chmodSync, rmSync } from 'node:fs';
      import { join } from 'node:path';
      process.umask(0);
      const dir = ${JSON.stringify(join(dir, 'private'))};
      const modes = [];
      try {
        for (let i = 0; i < 3; i++) {
          ghRestGetJson('repos/o/r/pulls', { dir, env: { VITEST: '1' },
            exec: () => 'HTTP/2.0 200 OK\\r\\nEtag: "e"\\r\\n\\r\\n[]' });
          const files = readdirSync(dir);
          modes.push([statSync(dir).mode & 0o777, ...files.map(f => statSync(join(dir, f)).mode & 0o777)]);
          chmodSync(join(dir, files[0]), 0o666);
        }
        console.log(JSON.stringify({ modes, count: readdirSync(dir).length }));
      } finally { rmSync(dir, { recursive: true, force: true }); }
    `], { encoding: 'utf8' }));
    expect(result).toEqual({ modes: Array(3).fill([0o700, 0o600]), count: 1 });
  });

  it.each(['', 'null', '[1]', '{"a":1}'])('fresh and cached JSON parity for %j', body => {
    const options = { dir, env: { VITEST: '1' } };
    const fresh = ghRestGetJson('p', { ...options, exec: () => ok(body) });
    const cached = ghRestGetJson('p', { ...options, exec: () => { throw notModified(); } });
    expect(cached.json).toEqual(fresh.json);
  });

  it.each(['   ', '{bad'])('nonempty invalid JSON throws fresh and cached for %j', body => {
    const options = { dir, env: { VITEST: '1' } };
    expect(() => ghRestGetJson('p', { ...options, exec: () => ok(body) })).toThrow(SyntaxError);
    ghRestGetJson('p', { ...options, exec: () => ok('null') });
    const file = join(dir, readdirSync(dir)[0]);
    const envelope = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...envelope, body }));
    expect(() => ghRestGetJson('p', { ...options, exec: () => { throw notModified(); } })).toThrow(SyntaxError);
  });

  it.each(['repos/', 'repos/o', 'repos//r/pulls', 'repos/o//pulls', 'repos/./r/pulls',
    'repos/o/../pulls', 'repos/o/r%2fx/pulls', 'repos/a%2fb/r/pulls', 'repos/o/r x/pulls',
    'repos/o/r?x/pulls', 'repos/o/r#x/pulls', 'repos/o?x/r/pulls', 'repos/{repo}/{owner}/pulls'])
  ('rejects invalid endpoint before execution or cache writes: %s', path => {
    let calls = 0;
    expect(() => ghRestGetJson(path, { dir, env: { VITEST: '1' }, exec: () => { calls++; return ok('[]'); } })).toThrow();
    expect(calls).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
  });

  it.each(['repos/o/r/pulls', 'repos/a.b-c_d/e.f-g_h/pulls?page=2', 'repos/{owner}/{repo}/pulls',
    'repos/o/r?per_page=2', 'user/repos?page=2'])
  ('preserves valid endpoint: %s', path => {
    let seen;
    expect(ghRestGetJson(path, { dir, env: { VITEST: '1' }, exec: (f, args) => {
      seen = args.at(-1); return ok('[]');
    } }).json).toEqual([]);
    expect(seen).toBe(path);
  });
});
