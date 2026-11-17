/**
 * @file scripts/conveyor/__tests__/conflict-fix-mark.test.mjs
 * @description Pins the PURE STACKED-BASE conflict-fix comment builder (#3383). Unlike
 *   `we:scripts/conveyor/conflict-fix-round-count.mjs`'s own test coverage (exercised via
 *   `reconcile-core.test.mjs`), this file pins `buildConflictFixMarkComment` directly: it reuses
 *   `CONFLICT_FIX_COMMENT_MARKER` from that module UNCHANGED (single-sourced, never a fourth marker) so a
 *   stacked-base round and an ordinary main-base conflict-fix round bind on the exact same durable
 *   `CONFLICT_FIX_ROUND_CAP` floor, and states plainly that it touches no `review:*` label.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { countConflictFixComments, CONFLICT_FIX_COMMENT_MARKER as ROUND_COUNT_MARKER } from '../conflict-fix-round-count.mjs';
import { buildConflictFixMarkComment, CONFLICT_FIX_COMMENT_MARKER } from '../conflict-fix-mark.mjs';

describe('conflict-fix-mark.mjs#CONFLICT_FIX_COMMENT_MARKER — single-sourced, never a fourth marker (#3383)', () => {
  it('is the IDENTICAL marker conflict-fix-round-count.mjs exports — never redeclared', () => {
    expect(CONFLICT_FIX_COMMENT_MARKER).toBe(ROUND_COUNT_MARKER);
  });
});

describe('buildConflictFixMarkComment — the durable STACKED-BASE conflict-fix comment (#3383)', () => {
  it('leads with the SAME marker the ordinary conflict-fix round posts, so both count against one cap', () => {
    const body = buildConflictFixMarkComment({ baseRefName: 'lane/3681-ratify-daemon-lifecycle' });
    expect(body.split('\n')[0]).toBe(CONFLICT_FIX_COMMENT_MARKER);
    // Round-trips through the SAME counter the ordinary conflict-fix round is counted with. #3383 — that
    // counter now also requires a trusted author.
    expect(countConflictFixComments([{ body, author: { login: 'web-everything' } }])).toBe(1);
  });

  it('names the base it resolved against', () => {
    const body = buildConflictFixMarkComment({ baseRefName: 'lane/3681-ratify-daemon-lifecycle' });
    expect(body).toContain('lane/3681-ratify-daemon-lifecycle');
  });

  it('falls back to generic wording when no baseRefName is given', () => {
    const body = buildConflictFixMarkComment({});
    expect(body).toContain('its own base branch');
  });

  it('states plainly that NO review label was touched — there was nothing to re-arm', () => {
    const body = buildConflictFixMarkComment({ baseRefName: 'lane/x' });
    expect(body).toContain('review:accepted');
    expect(body).toContain('review:changes');
    expect(body.toLowerCase()).toContain('did not touch');
  });

  it('a human quoting the marker mid-body never inflates the count (leading-line narrowing, shared with the round-count reader)', () => {
    const quoted = `> ${CONFLICT_FIX_COMMENT_MARKER}\na human quoting it in a reply`;
    expect(countConflictFixComments([{ body: quoted }])).toBe(0);
  });
});

describe('conflict-fix-mark CLI — retired accepted conflict hand-backs fail closed', () => {
  const script = resolve(dirname(fileURLToPath(import.meta.url)), '../conflict-fix-mark.mjs');
  it.each([
    ['retired conflict-rebase mode', ['--mode=conflict-rebase']],
    ['malformed accepted-conflict-rebase actor receipt', ['--actor=accepted-conflict-rebase:incomplete']],
    ['duplicate mode cannot hide a retired invocation', ['--mode=conflict-rebase', '--mode=stacked-rebase']],
    ['duplicate actor cannot hide a retired receipt', ['--actor=accepted-conflict-rebase:old-receipt', '--actor=fixer']],
  ])('rejects %s with nonzero exit, a rearm-review fallback and no comment', (_name, args) => {
    const dir = mkdtempSync(join(tmpdir(), 'conflict-mark-retired-cli-'));
    try {
      const log = join(dir, 'gh-calls');
      // Any attempted write reaches this recording fake, never the real GitHub CLI.
      writeFileSync(join(dir, 'gh'), '#!/usr/bin/env node\n'
        + "require('node:fs').appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');\n",
      { mode: 0o755 });
      const result = spawnSync(process.execPath, [script, '6911', '--repo=o/n', ...args], {
        env: { ...process.env, PATH: `${dir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`, FAKE_GH_LOG: log },
        encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('run rearm-review.mjs --round=conflict-start');
      expect(result.stdout).not.toContain('"commented":true');
      expect(existsSync(log)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
