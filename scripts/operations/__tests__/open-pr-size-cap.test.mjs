/**
 * @file open-pr-size-cap.test.mjs — red-first contract for the pre-submit size cap.
 * All runner IO is injected; only the recorded-bypass body uses a temporary file.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as openPr from '../open-pr.mjs';
import { createPrLandRunner } from '../open-pr-io.mjs';

const argv = ['--ref=lane/size-cap'];
const opened = { outcome: 'opened', pr: 7, url: 'u' };
const fixture = (numstatText, overrides = {}) => {
  const prePrReview = vi.fn(() => ({ action: 'pass' }));
  const diffStat = vi.fn(() => numstatText);
  const spawn = vi.fn(() => ({ status: 0, stdout: JSON.stringify({ pr: 7, url: 'u' }) }));
  const run = createPrLandRunner({ prePrReview, diffStat, spawn, ...overrides });
  return { run, prePrReview, diffStat, spawn };
};

describe('measureNonTestLines — pure numstat accounting', () => {
  it('exports a 300-line non-test limit', () => {
    expect(openPr.OPEN_PR_MAX_NON_TEST_LINES).toBe(300);
  });

  it('treats empty input as zero changes without a backlog exemption', () => {
    expect(openPr.measureNonTestLines('')).toEqual({ lines: 0, exempt: false });
  });

  it('sums additions and deletions across non-test paths, with or without a trailing newline', () => {
    const text = '100\t50\tscripts/operations/open-pr.mjs\n20\t30\tdocs/a guide.md';
    expect(openPr.measureNonTestLines(text)).toEqual({ lines: 200, exempt: false });
    expect(openPr.measureNonTestLines(`${text}\n`)).toEqual({ lines: 200, exempt: false });
  });

  it.each([
    '__tests__/a.mjs',
    'scripts/x/__tests__/a.test.mjs',
    'scripts/x/__tests__/fixtures/input.json',
    'a.test.mjs',
    'scripts/x/a.spec.ts',
  ])('excludes additions and deletions for test path %s', (path) => {
    expect(openPr.measureNonTestLines(`200\t50\tscripts/x.mjs\n600\t300\t${path}\n`))
      .toEqual({ lines: 250, exempt: false });
  });

  it('counts similarly named non-test paths', () => {
    expect(openPr.measureNonTestLines('10\t5\tscripts/__tests__helpers/a.mjs\n20\t5\tscripts/a.testing.mjs\n'))
      .toEqual({ lines: 40, exempt: false });
  });

  it('exempts a nonempty diff only when every path starts with backlog/', () => {
    expect(openPr.measureNonTestLines('700\t100\tbacklog/a.md\n150\t50\tbacklog/nested/b.md\n'))
      .toEqual({ lines: 1000, exempt: true });
    expect(openPr.measureNonTestLines('0\t0\tbacklog/a.md\n'))
      .toEqual({ lines: 0, exempt: true });
  });

  it('does not exempt mixed paths, even when the outside path is a test', () => {
    expect(openPr.measureNonTestLines('1000\t0\tbacklog/a.md\n1\t0\tscripts/a.mjs\n'))
      .toEqual({ lines: 1001, exempt: false });
    expect(openPr.measureNonTestLines('1000\t0\tbacklog/a.md\n900\t0\tscripts/a.test.mjs\n'))
      .toEqual({ lines: 1000, exempt: false });
  });

  it.each([
    ['binary counts', '-\t-\tassets/image.png\n'],
    ['non-numeric additions', 'oops\t1\tscripts/a.mjs\n'],
    ['non-numeric deletions', '1\toops\tscripts/a.mjs\n'],
    ['missing count', '1\tscripts/a.mjs\n'],
    ['missing path', '1\t2\n'],
    ['empty path', '1\t2\t\n'],
    ['malformed line after valid evidence', '1\t2\tscripts/a.mjs\nmalformed\n'],
    ['binary test file', '-\t-\tscripts/a.test.mjs\n'],
    ['binary backlog file', '-\t-\tbacklog/a.md\n'],
  ])('throws rather than silently undercounting %s', (_name, text) => {
    expect(openPr.measureNonTestLines).toBeTypeOf('function');
    expect(() => openPr.measureNonTestLines(text)).toThrow();
  });
});

describe('createPrLandRunner — non-test size admission', () => {
  it.each([300, 301])('enforces the inclusive 300-line boundary at %i lines', (lines) => {
    const { run, diffStat, spawn } = fixture(`${lines - 100}\t100\tscripts/a.mjs\n`);
    const result = run({ argv });
    if (lines === 300) {
      expect(result).toMatchObject(opened);
      expect(spawn).toHaveBeenCalledTimes(1);
    } else {
      expect(result).toMatchObject({ outcome: 'refused', reason: 'pr-too-large' });
      expect(result.detail).toMatch(/301/);
      expect(result.detail).toMatch(/300/);
      expect(result.detail).toMatch(/split/i);
      expect(spawn).not.toHaveBeenCalled();
    }
    expect(diffStat).toHaveBeenCalledTimes(1);
  });

  it('admits 250 non-test lines plus 900 lines in a nested __tests__ file', () => {
    const { run, diffStat, spawn } = fixture('200\t50\tscripts/a.mjs\n600\t300\tscripts/x/__tests__/a.test.mjs\n');
    expect(run({ argv })).toMatchObject(opened);
    expect(diffStat).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('admits a backlog-only diff of 1000 lines', () => {
    const { run, diffStat, spawn } = fixture('700\t100\tbacklog/a.md\n150\t50\tbacklog/b.md\n');
    expect(run({ argv })).toMatchObject(opened);
    expect(diffStat).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('refuses an oversized mixed backlog and code diff without the exemption', () => {
    const { run, spawn } = fixture('1000\t0\tbacklog/a.md\n1\t0\tscripts/a.mjs\n');
    expect(run({ argv })).toMatchObject({ outcome: 'refused', reason: 'pr-too-large' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    ['a throwing reader', () => { throw new Error('diff unavailable'); }],
    ['binary numstat', () => '-\t-\tassets/image.png\n'],
    ['malformed numstat', () => 'not numstat\n'],
    ['partially readable numstat', () => '1\t0\tscripts/a.mjs\nmalformed\n'],
  ])('fails closed with pr-size-unreadable for %s and never spawns', (_name, read) => {
    const diffStat = vi.fn(read);
    const { run, spawn } = fixture('', { diffStat });
    expect(run({ argv })).toMatchObject({ outcome: 'refused', reason: 'pr-size-unreadable' });
    expect(diffStat).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('checks size after the pre-PR review gate and before spawning', () => {
    const order = [];
    const { run } = fixture('', {
      prePrReview: () => { order.push('review'); return { action: 'pass' }; },
      diffStat: () => { order.push('size'); return '1\t0\tscripts/a.mjs\n'; },
      spawn: () => { order.push('spawn'); return { status: 0, stdout: JSON.stringify({ pr: 7, url: 'u' }) }; },
    });
    expect(run({ argv })).toMatchObject(opened);
    expect(order).toEqual(['review', 'size', 'spawn']);
  });

  it('does not read a diff or spawn when the pre-PR review gate refuses', () => {
    const { run, diffStat, spawn } = fixture('', {
      prePrReview: () => ({ action: 'refuse', reason: 'pre-pr-review-missing' }),
    });
    expect(run({ argv })).toMatchObject({ outcome: 'refused', reason: 'pre-pr-review-missing' });
    expect(diffStat).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    [[], { base: 'main', sha: 'HEAD' }],
    [['--base=release', '--sha=abc123'], { base: 'release', sha: 'abc123' }],
  ])('passes the requested base and sha to diffStat for argv %j', (extra, expected) => {
    const { run, diffStat, spawn } = fixture('');
    expect(run({ argv: [...argv, ...extra] })).toMatchObject(opened);
    expect(diffStat).toHaveBeenCalledTimes(1);
    expect(diffStat).toHaveBeenCalledWith(expected);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('skips size admission for --dry-run', () => {
    const { run, prePrReview, diffStat, spawn } = fixture('1000\t0\tscripts/a.mjs\n');
    expect(run({ argv: [...argv, '--dry-run'] })).toMatchObject(opened);
    expect(prePrReview).not.toHaveBeenCalled();
    expect(diffStat).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('reuses the recorded pre-PR review bypass to skip size admission', () => {
    const dir = mkdtempSync(join(tmpdir(), 'open-pr-size-cap-'));
    try {
      const bodyFile = join(dir, 'body.md');
      writeFileSync(bodyFile, 'PR body\n');
      const prePrReview = vi.fn(() => ({
        action: 'pass', bypass: { reason: 'r', actor: 'a', operatorInstruction: 'i' },
      }));
      const { run, diffStat, spawn } = fixture('1000\t0\tscripts/a.mjs\n', { prePrReview });
      expect(run({ argv: [...argv, `--body-file=${bodyFile}`] })).toMatchObject(opened);
      expect(prePrReview).toHaveBeenCalledTimes(1);
      expect(diffStat).not.toHaveBeenCalled();
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
