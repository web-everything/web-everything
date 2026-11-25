/**
 * @file review-loop-cli-error-class.test.mjs — REVIEW-CLI-ERROR-CLASS: review-loop-cli prints a FIXED error
 * class, never a raw error message (a probe leaked a synthetic Bearer token through park output / filing results).
 * Merge-path checklist 7 (fail-open catches: an unknown error parks, never accepts) and 8 (write ordering: a
 * failed filing leaves the state as it was) — the end-to-end negatives live in review-loop-cli.test.mjs
 * ("error-class" describe); this file pins the classifier and the static ban on `.message` in output.
 */
import { readFileSync, writeFileSync, mkdtempSync, symlinkSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

import * as cli from '../review-loop-cli.mjs';

const SOURCE = readFileSync(join(process.cwd(), 'scripts/operations/review-loop-cli.mjs'), 'utf8');
const CLASSES = ['auth', 'network', 'rate-limit', 'not-found', 'parse', 'unknown'];

describe('classifyErrorClass', () => {
  it('an error carrying a Bearer token prints only its error class', () => {
    const e = new Error('401 Unauthorized: Authorization: Bearer test-xyz-secret');
    const cls = cli.classifyErrorClass(e);
    expect(cls).toBe('auth');
    expect(cli.describeErrorClass('filing-failed', e, { log: () => {} })).toBe('filing-failed:auth');
    expect(cli.describeErrorClass('filing-failed', e, { log: () => {} })).not.toMatch(/test-xyz/);
  });

  it('maps each message shape to a class from the fixed list', () => {
    expect(cli.classifyErrorClass(new Error('connect ECONNREFUSED 1.2.3.4'))).toBe('network');
    expect(cli.classifyErrorClass(new Error('API rate limit exceeded (429)'))).toBe('rate-limit');
    expect(cli.classifyErrorClass(new Error('HTTP 404 Not Found'))).toBe('not-found');
    expect(cli.classifyErrorClass(new SyntaxError('Unexpected token < in JSON at position 0'))).toBe('parse');
  });

  it('an unknown error maps to class unknown', () => {
    expect(cli.classifyErrorClass(new Error('backlog write failed: disk full'))).toBe('unknown');
    expect(cli.classifyErrorClass(undefined)).toBe('unknown');
    expect(cli.classifyErrorClass('plain string with a secret')).toBe('unknown');
    for (const e of [new Error('x'), null, 42]) expect(CLASSES).toContain(cli.classifyErrorClass(e));
  });

  it('the full message goes only to the debug sink, never into the returned text', () => {
    const seen = [];
    const out = cli.describeErrorClass('error', new Error('boom Bearer abc123'), { log: (s, m) => seen.push([s, m]) });
    expect(out).toBe('error:auth');
    expect(seen).toHaveLength(1);
    expect(String(seen[0][1].message)).toMatch(/abc123/);
  });
});

describe('debug log fails closed', () => {
  it('never appends through a symlink or into a group/world-readable file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rlc-dbg-'));
    const target = join(dir, 'target.txt');
    writeFileSync(target, 'orig');
    const link = join(dir, 'link.log');
    symlinkSync(target, link);
    const open = join(dir, 'open.log');
    writeFileSync(open, 'orig', { mode: 0o644 });
    chmodSync(open, 0o644);
    for (const p of [link, open]) {
      const prev = process.env.REVIEW_LOOP_CLI_DEBUG_LOG;
      process.env.REVIEW_LOOP_CLI_DEBUG_LOG = p;
      try { cli.describeErrorClass('x', new Error('Bearer leak-me')); }
      finally { if (prev === undefined) delete process.env.REVIEW_LOOP_CLI_DEBUG_LOG; else process.env.REVIEW_LOOP_CLI_DEBUG_LOG = prev; }
    }
    expect(readFileSync(target, 'utf8')).toBe('orig');
    expect(readFileSync(open, 'utf8')).toBe('orig');
    expect(statSync(open).mode & 0o777).toBe(0o644);
  });
});

describe('every catch site in review-loop-cli maps to a class from the fixed list', () => {
  it('no output string interpolates an error message', () => {
    const offenders = SOURCE.split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /\?\.message|\berror\.message|\be\.message|\berr\.message/.test(line))
      // the classifier itself is the only place allowed to read a message
      .filter(({ line }) => !/\/\/ error-class-allowed/.test(line));
    expect(offenders).toEqual([]);
  });
});
