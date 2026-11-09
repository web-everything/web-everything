// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { resultToVerdictInputs, runCli } from '../drain-classify-only.mjs';
import { isMutatingGhCall } from '../lib/drain-classify-guard.mjs';
import { digest } from '../lib/drain-verdict.mjs';

const row = { num: 7, repo: 'o/r', headSha: 'head' };
const base = () => ({ ok: true, dryRun: true, toMerge: [], skipped: [], parked: [], skipReasons: [] });
const ctx = { pr: 7, repo: 'o/r', mainSha: 'main', codeSha: 'code', gateTree: 'tree',
  settingsDigest: digest({}), computedAt: '2026-11-09T12:00:00.000Z' };
const fixtures = [
  ['enqueue', { ...base(), toMerge: [row] }],
  ['hold', { ...base(), skipped: [{ ...row, humanRequired: true, reason: 'review:human' }] }],
  ['hold', { ...base(), parked: [{ ...row, humanRequired: true, reasons: ['workflow hold'] }] }],
  ['hold', { ...base(), skipped: [{ ...row, reason: 'review hold: awaiting review' }] }],
  ['local', { ...base(), parked: [{ ...row, humanRequired: false, reasons: ['agent-reviewable'] }] }],
  ['local', { ...base(), skipped: [{ ...row, reason: 'checks pending' }], skipReasons: [{ ...row, kind: 'checks-pending', reason: 'checks pending' }] }],
  ['hold', { ...base(), skipped: [{ ...row, reason: 'clearance needed' }], skipReasons: [{ ...row, kind: 'review-hold', reason: 'clearance needed' }] }],
];

function ioFor(result) {
  const calls = [];
  return { calls, env: { TEST_SETTING: 'fixture' }, now: () => Date.parse(ctx.computedAt),
    readSettings: () => ({ settings: {}, sources: ['fixture'], errors: [] }),
    execFileSync: (cmd, args, options) => {
      calls.push({ cmd, args, options });
      if (cmd === 'git' && args[0] === 'rev-parse') return { 'origin/main': 'main', HEAD: 'code', 'HEAD:scripts': 'tree' }[args[1]];
      if (cmd === process.execPath) return JSON.stringify(result);
      throw new Error('unexpected command');
    }, writeFileSync: vi.fn() };
}

describe('additive classify-only entry', () => {
  it.each(fixtures)('has dry-run parity: %s (%j)', (decision, result) => {
    expect(resultToVerdictInputs(result, ctx).decision).toBe(decision);
  });
  it('derives failing gate evidence only from inventory skip kinds and retains unknowns', () => {
    const v = resultToVerdictInputs(fixtures[5][1], ctx);
    expect(v.gates.find(g => g.id === 'required-check-green')).toMatchObject({ result: 'fail', evidence: expect.stringContaining('checks pending') });
    expect(v.gates.find(g => g.id === 'codeql').result).toBe('unknown');
    expect(v.gates.find(g => g.id === 'red-main-freeze').result).toBe('unknown');
  });
  it('binds labels/checks where available and keeps key-order digest parity', () => {
    const fixture = { ...base(), toMerge: [{ ...row, labels: ['ready-to-merge'], checks: [{ state: 'SUCCESS', name: 'test' }] }] };
    const v = resultToVerdictInputs(fixture, ctx);
    const shuffled = { ...fixture, toMerge: [{ checks: [{ name: 'test', state: 'SUCCESS' }], labels: ['ready-to-merge'], ...row }] };
    expect(resultToVerdictInputs(shuffled, ctx).inputsDigest).toBe(v.inputsDigest);
    expect(resultToVerdictInputs(fixtures[0][1], ctx).inputsDigest).not.toBe(v.inputsDigest);
  });
  it.each([
    { ...base(), ok: false }, { ...base(), dryRun: false }, { ...base(), failedRepos: [{}] },
    base(), { ...base(), toMerge: undefined }, { ...base(), toMerge: [{ ...row, headSha: null }] },
    { ...base(), toMerge: [row], skipped: [row] },
    { ...base(), skipped: [row], parked: [{ ...row, headSha: 'other' }] },
  ])('refuses incomplete or contradictory evidence with local fallback (%j)', result => {
    expect(() => resultToVerdictInputs(result, ctx)).toThrow(/local drain/);
  });
  it('writes verdict-out, launches the guarded dry-run, and makes zero mutating calls with injected seam', () => {
    const dir = mkdtempSync(join(process.env.TMPDIR, 'drain-classify-'));
    try {
      const out = join(dir, 'verdict.json');
      const io = ioFor(fixtures[0][1]); delete io.writeFileSync;
      const v = runCli(['--only=7', '--classify-only', `--verdict-out=${out}`, '--repo=o/r', '--max-age=10'], io);
      expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(v);
      expect(v.actions).toContainEqual({ type: 'enqueue', repo: 'o/r', pr: 7, headSha: 'head' });
      const child = io.calls.find(c => c.cmd === process.execPath);
      expect(child.args).toEqual(expect.arrayContaining(['--import', '--only=7', '--dry-run', '--json', '--no-drain-lease', '--only-repo=o/r', '--repos=o/r']));
      expect(child.options.env.DRAIN_CLASSIFY_ONLY).toBe('1');
      expect(child.options.maxBuffer).toBe(16 * 1024 * 1024);
      expect(io.calls.filter(c => isMutatingGhCall(c.cmd, c.args))).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('is off by default and refuses invalid flags before any IO', () => {
    const io = ioFor(fixtures[0][1]);
    for (const args of [[], ['--only=7', '--verdict-out=x'], ['--only=0', '--classify-only', '--verdict-out=x'],
      ['--only=7', '--classify-only', '--verdict-out=x', '--max-age=no'],
      ['--only=7', '--classify-only', '--verdict-out=x', '--repo=invalid']]) {
      expect(() => runCli(args, io)).toThrow();
    }
    expect(io.calls).toHaveLength(0);
  });
  it.each(['bad-json', 'oversized', 'settings', 'moving-main', 'expired', 'child-failure'])('fails closed without writing on %s and names local fallback', kind => {
    const io = ioFor(fixtures[0][1]);
    const exec = io.execFileSync;
    let mainReads = 0; let nowReads = 0;
    io.execFileSync = (cmd, args, options) => {
      if (cmd === process.execPath && kind === 'child-failure') throw new Error('maxBuffer exceeded');
      if (cmd === process.execPath && kind === 'bad-json') return 'diagnostic\n{}';
      if (cmd === process.execPath && kind === 'oversized') return 'x'.repeat(16 * 1024 * 1024 + 1);
      if (cmd === 'git' && args[1] === 'origin/main' && kind === 'moving-main') return ++mainReads === 1 ? 'main' : 'moved';
      return exec(cmd, args, options);
    };
    if (kind === 'settings') io.readSettings = () => ({ errors: ['unreadable'] });
    if (kind === 'expired') io.now = () => Date.parse(ctx.computedAt) + (nowReads++ ? 11 * 60_000 : 0);
    expect(() => runCli(['--only=7', '--classify-only', '--verdict-out=x', '--repo=o/r'], io)).toThrow(/local drain/);
    expect(io.writeFileSync).not.toHaveBeenCalled();
  });
});
