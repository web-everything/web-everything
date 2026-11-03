/**
 * @file R492 S1 — the hot review reads go through the shared ETag REST cache (ghRestGetJson):
 *   a repeat read sends If-None-Match and is answered 304 from the cache, with the same mapped result.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultReadChangedFiles } from '../review-loop-cli.mjs';
import { createRedTeamIo } from '../review-extra-seats.mjs';

const made = [];
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fakeGh(bodyJson) {
  const dir = mkdtempSync(join(tmpdir(), 'rest-etag-')); made.push(dir);
  const log = join(dir, 'argv.log');
  writeFileSync(join(dir, 'gh'), `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv.some(a => /If-None-Match: "v1"/.test(a))) { process.stdout.write('HTTP/2.0 304 Not Modified\\netag: "v1"\\n\\n'); process.exit(0); }
process.stdout.write('HTTP/2.0 200 OK\\netag: "v1"\\n\\n' + ${JSON.stringify(JSON.stringify(bodyJson))});
`);
  chmodSync(join(dir, 'gh'), 0o755);
  return { dir, calls: () => readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) };
}
const withEnv = (f, fn) => {
  const prev = { PATH: process.env.PATH, WE_GH_ETAG_DIR: process.env.WE_GH_ETAG_DIR, WE_GH_PERSONAL_ROUTE: process.env.WE_GH_PERSONAL_ROUTE };
  process.env.PATH = `${f.dir}:${process.env.PATH}`;
  process.env.WE_GH_ETAG_DIR = join(f.dir, 'etag');
  try { return fn(); } finally { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};

describe('review reads route through the shared ETag cache', () => {
  it('changed-files: REST api -i, conditional on the repeat, same mapped paths', () => {
    const f = fakeGh([{ filename: 'a.mjs', previous_filename: 'b.mjs', patch: 'x' }]);
    const a = withEnv(f, () => defaultReadChangedFiles({ pr: 7, repo: 'o/r' }));
    const b = withEnv(f, () => defaultReadChangedFiles({ pr: 7, repo: 'o/r' }));
    expect(b).toEqual(a);
    expect(a).toContain('a.mjs');
    const calls = f.calls();
    expect(calls[0].slice(0, 2)).toEqual(['api', '-i']);
    expect(calls[1].join(' ')).toContain('If-None-Match: "v1"');
  });
  it('red-team listComments: REST issue comments with user.login', () => {
    const f = fakeGh([{ body: 'hi', user: { login: 'bot' } }]);
    const io = createRedTeamIo({ env: process.env });
    const first = withEnv(f, () => io.listComments({ pr: 3, repo: 'o/r' }));
    const second = withEnv(f, () => io.listComments({ pr: 3, repo: 'o/r' }));
    expect(second).toEqual(first);
    expect(first[0].user.login).toBe('bot');
    expect(f.calls()[0].join(' ')).toContain('repos/o/r/issues/3/comments');
    expect(f.calls()[1].join(' ')).toContain('If-None-Match');
  });
});
