/** The ruling CLI always prints its result or refusal, and refuses a judge run without the App gh shim on PATH. */
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main, assertJudgeShimOnPath } from '../record-red-team-ruling-cli.mjs';

describe('record-red-team-ruling-cli prints every exit path', () => {
  it('prints usage on --help and returns 0', async () => {
    const out = [];
    const code = await main(['--help'], { write: (s) => out.push(s) });
    expect(code).toBe(0);
    expect(out.join('')).toMatch(/usage|--pr/i);
  });
  it('prints the refusal text when the entry throws', async () => {
    const out = [];
    const code = await main(['--pr=1'], { entry: () => { throw new Error('boom refusal'); }, write: (s) => out.push(s) });
    expect(code).not.toBe(0);
    expect(out.join('')).toMatch(/boom refusal/);
  });
  it('prints the outcome lines and returns the outcome code', async () => {
    const out = [];
    const code = await main(['--pr=1'], { run: async () => ({ lines: ['ruled'], code: 0 }), write: (s) => out.push(s) });
    expect(code).toBe(0);
    expect(out.join('')).toMatch(/ruled/);
  });
  it('refuses a judge run when the gh shim is not on PATH, with a clear message', () => {
    expect(() => assertJudgeShimOnPath({ PATH: '/usr/bin' }, 'judge:r10')).toThrow(/gh-shim/);
    expect(() => assertJudgeShimOnPath({ PATH: '/x/gh-shim.d/abc:/usr/bin' }, 'judge:r10')).toThrow(/gh-shim/);
    expect(() => assertJudgeShimOnPath({ PATH: '/usr/bin' }, 'operator')).not.toThrow();
  });
});

describe('judge shim filesystem validation', () => {
  function fixture(check) {
    const home = fs.mkdtempSync(join(tmpdir(), 'judge-shim-'));
    try {
      const root = join(home, '.claude/github-app-token/gh-shim.d');
      const shim = join(root, 'app');
      fs.mkdirSync(shim, { recursive: true });
      fs.writeFileSync(join(shim, 'gh'), '#!/bin/sh\n', { mode: 0o700 });
      check({ home, root, shim, deps: { homedir: () => home, fs } });
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }
  it('accepts a real shim directory containing executable gh', () => fixture(({ shim, deps }) => {
    expect(() => assertJudgeShimOnPath({ PATH: [shim, '/usr/bin'].join(delimiter) }, 'judge:r10', deps)).not.toThrow();
  }));
  it.each(['missing directory', 'missing gh', 'non-executable gh', 'gh directory', 'sibling prefix', 'escaping symlink', 'unreadable filesystem'])(
    'refuses %s with the shim setup message', kind => fixture(({ home, root, shim, deps }) => {
      let path = shim;
      if (kind === 'missing directory') path = join(shim, 'missing');
      if (kind === 'missing gh') fs.unlinkSync(join(shim, 'gh'));
      if (kind === 'non-executable gh') fs.chmodSync(join(shim, 'gh'), 0o600);
      if (kind === 'gh directory') { fs.unlinkSync(join(shim, 'gh')); fs.mkdirSync(join(shim, 'gh')); }
      if (kind === 'sibling prefix' || kind === 'escaping symlink') {
        const outside = root + '-other';
        fs.mkdirSync(outside);
        fs.writeFileSync(join(outside, 'gh'), '#!/bin/sh\n', { mode: 0o700 });
        path = outside;
        if (kind === 'escaping symlink') { path = join(root, 'escape'); fs.symlinkSync(outside, path); }
      }
      if (kind === 'unreadable filesystem') deps.fs = { ...fs, realpathSync() { throw new Error('unreadable'); } };
      expect(() => assertJudgeShimOnPath({ PATH: path }, 'judge:r10', deps)).toThrow(/App gh shim.*prepend/);
    }));
});
