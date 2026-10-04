/**
 * @file scripts/conveyor/__tests__/open-pr-fetch-rest-live.test.mjs
 * @description #4351's own build-dispatch follow-up (guided by #4309 spend accounting) — `fetchOpenPrsRest` (open-pr-fetch.mjs), the
 *   build-dispatch daemon's REST replacement for `defaultFetchOpenPrs`, through the REAL throttle stack (no
 *   `vi.mock` at all) with a PATH-faked `gh` binary standing in for the network. Proves the ETag 304 path this
 *   card's live proof needs: a repeat tick's list AND every PR's files page answer with a free `304`, the
 *   throttle's own call log never records anything but the `core` resource (never `graphql`), and the faked
 *   binary would itself fail loudly (`exit 97`) if this path ever fell back to `gh pr list`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchOpenPrsRest } from '../open-pr-fetch.mjs';

const FIXTURE = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'open-prs-rest-vs-graphql.json'), 'utf8',
));

describe('fetchOpenPrsRest — real throttle + ETag 304 path (PATH-faked gh, no network)', () => {
  let dir;
  let saved;
  let lockRoot;
  let argvLog;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'open-pr-fetch-rest-'));
    saved = { PATH: process.env.PATH, WE_GH_THROTTLE_LOCK_ROOT: process.env.WE_GH_THROTTLE_LOCK_ROOT, WE_GH_ETAG_DIR: process.env.WE_GH_ETAG_DIR };
    lockRoot = join(dir, 'lock');
    argvLog = join(dir, 'argv.log');
    const bin = mkdtempSync(join(tmpdir(), 'open-pr-fetch-rest-gh-'));
    const listBody = join(dir, 'list.json');
    const files2901 = join(dir, 'files-2901.json');
    const files2902 = join(dir, 'files-2902.json');
    writeFileSync(listBody, JSON.stringify(FIXTURE.restPulls));
    writeFileSync(files2901, JSON.stringify(FIXTURE.restFiles['2901']));
    writeFileSync(files2902, JSON.stringify(FIXTURE.restFiles['2902']));
    writeFileSync(join(bin, 'gh'), [
      '#!/bin/sh',
      `echo "$*" >> '${argvLog}'`,
      '[ "$1" = "pr" ] && { echo "graphql pr list must not run" >&2; exit 97; }',
      'case "$*" in *If-None-Match*) printf \'HTTP/2.0 304 Not Modified\\r\\nEtag: "e1"\\r\\n\\r\\n\'; echo "gh: HTTP 304" >&2; exit 1;; esac',
      'case "$*" in',
      `  *pulls/2901/files*) printf 'HTTP/2.0 200 OK\\r\\nEtag: W/"e1"\\r\\n\\r\\n'; cat '${files2901}';;`,
      `  *pulls/2902/files*) printf 'HTTP/2.0 200 OK\\r\\nEtag: W/"e1"\\r\\n\\r\\n'; cat '${files2902}';;`,
      `  *) printf 'HTTP/2.0 200 OK\\r\\nEtag: W/"e1"\\r\\n\\r\\n'; cat '${listBody}';;`,
      'esac',
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

  it('a repeat tick reads the list AND every PR\'s files as free 304s, and spends only the core bucket', () => {
    const first = fetchOpenPrsRest({ repo: 'web-everything/web-everything' });
    const second = fetchOpenPrsRest({ repo: 'web-everything/web-everything' });
    expect(first).toEqual(FIXTURE.graphql);
    expect(second).toEqual(FIXTURE.graphql); // served from the ETag cache, same answer

    const argv = readFileSync(argvLog, 'utf8').trim().split('\n');
    expect(argv).toHaveLength(6); // 3 unconditional GETs (tick 1) + 3 conditional GETs (tick 2)
    expect(argv.slice(3).every((line) => line.includes('If-None-Match'))).toBe(true);
    expect(argv.every((line) => !line.startsWith('pr '))).toBe(true); // never falls back to graphql `gh pr list`

    const entries = readFileSync(join(lockRoot, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(entries.every((e) => e.resource === 'core')).toBe(true); // never `graphql`
    expect(entries.filter((e) => e.outcome === 'not_modified')).toHaveLength(3); // tick 2's list + 2 files pages
  });
});
