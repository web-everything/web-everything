import { convergingRead } from './round-grant-fixture.mjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { assertRoundGrantAllowed } from '../round-grant-guard.mjs';
import { judgeRound } from '../round-judge.mjs';
import { readNonconvergenceDesign } from '../../operations/extend-rounds-io.mjs';

vi.mock('../round-judge.mjs', async (original) => {
  const actual = await original();
  return { ...actual, judgeRound: vi.fn(actual.judgeRound) };
});
afterEach(() => { vi.mocked(judgeRound).mockReset(); vi.mocked(judgeRound).mockImplementation(actualJudge); });
const actualJudge = (await vi.importActual('../round-judge.mjs')).judgeRound;
const base = { repo: 'web-everything/web-everything', pr: 12, ...convergingRead() };
const override = { despite: 'R1200', despiteDesign: { path: 'designs/x-nonconvergence.md', exists: true } };

describe('shared round grant guard', () => {
  it('refuses when the completeness total is missing', () => {
    const { commentsTotal, ...missing } = base;
    expect(() => assertRoundGrantAllowed(missing)).toThrow(/round extension refused: history incomplete/);
    expect(() => assertRoundGrantAllowed({ ...base, commentsTotal: undefined, ...override })).toThrow(/history incomplete/);
    expect(judgeRound).not.toHaveBeenCalled();
  });
  it('refuses escalate and send-back verdicts, admits only converging ones', () => {
    for (const verdict of ['escalate', 'send-back', 'suggest-split', 'unknown']) {
      vi.mocked(judgeRound).mockReturnValue({ verdict, reasons: ['observed'] });
      expect(() => assertRoundGrantAllowed({ ...base, ...override })).toThrow(verdict);
    }
    for (const verdict of ['grant', 'not-real-verified', 'card-the-rest']) {
      vi.mocked(judgeRound).mockReturnValue({ verdict, reasons: ['observed'],
        ...(verdict === 'grant' ? { k: 1 } : {}), ...(verdict === 'not-real-verified' ? { proof: ['verified'] } : {}) });
      expect(assertRoundGrantAllowed(base).verdict).toBe(verdict);
    }
  });
  it('names an unknown verdict even when its reasons are malformed', () => {
    vi.mocked(judgeRound).mockReturnValue({ verdict: 'unknown', reasons: {} });
    expect(() => assertRoundGrantAllowed(base)).toThrow(/verdict unknown/);
  });
  it('refuses a real no-file-evidence verdict even despite a design override', () => {
    expect(() => assertRoundGrantAllowed({ ...base, files: [], ...override })).toThrow(/send-back.*no-file-evidence-no-grant/);
  });
  it.each([null, undefined, {}])('refuses unreadable comments %j', comments => {
    expect(() => assertRoundGrantAllowed({ ...base, comments })).toThrow(/comments|history/);
  });
  it.each([1, 150, null, -1, '0', NaN, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1])('refuses incomplete comment evidence with total %j even despite a ruling', commentsTotal => {
    expect(() => assertRoundGrantAllowed({ ...base, ...override, commentsTotal })).toThrow(/incomplete/i);
    expect(judgeRound).not.toHaveBeenCalled();
  });
  it('accepts a matching mandatory comment total', () => {
    expect(() => assertRoundGrantAllowed(base)).not.toThrow();
  });
  it.each([null, {}, ['a', null], [42]])('refuses malformed files %j, even despite a ruling', files => {
    expect(() => assertRoundGrantAllowed({ ...base, ...override, files })).toThrow();
  });
  it('returns the judge result and always enables the cross-source stop', () => {
    const result = assertRoundGrantAllowed(base);
    expect(result.verdict).toBe('grant');
    expect(result.evidence.failClosed).not.toBe(true);
    expect(judgeRound).toHaveBeenCalledWith({ pr: 12, repo: base.repo, head: '', trigger: 'review-cap', comments: base.comments, files: base.files, nonConverging: { enabled: true } });
  });
  it.each(['throw', 'invalid', 'closed'])('despite cannot override a %s judge', kind => {
    if (kind === 'throw') vi.mocked(judgeRound).mockImplementationOnce(() => { throw new Error('judge unavailable'); });
    else vi.mocked(judgeRound).mockReturnValueOnce(kind === 'invalid' ? {} : { verdict: 'escalate', evidence: { failClosed: true } });
    expect(() => assertRoundGrantAllowed({ ...base, ...override })).toThrow();
  });
  it('malformed files make the real judge fail closed and cannot authorize a grant', () => {
    expect(actualJudge({ ...base, head: '', trigger: 'review-cap', files: {} }).evidence.failClosed).toBe(true);
    expect(() => assertRoundGrantAllowed({ ...base, ...override, files: {} })).toThrow();
  });
  it('refuses a non-converging verdict unless both bounded override fields are valid', () => {
    vi.mocked(judgeRound).mockReturnValue({ ...actualJudge({ ...base, head: '', trigger: 'review-cap' }), verdict: 'non-converging', k: undefined });
    expect(() => assertRoundGrantAllowed(base)).toThrow('non-converging round extension refused: route to redesign (R88/R115/D-R451)');
    expect(assertRoundGrantAllowed({ ...base, ...override }).verdict).toBe('non-converging');
    for (const despite of ['R1234567', 'R1\n', 'x', null]) expect(() => assertRoundGrantAllowed({ ...base, ...override, despite })).toThrow(/despite/);
  });
  it('reader accepts regular designs and refuses directories, outside symlinks and missing designs', () => {
    const root = mkdtempSync(join(tmpdir(), 'round-grant-design-'));
    try {
      mkdirSync(join(root, 'designs'));
      const file = 'designs/file-nonconvergence.md';
      const dir = 'designs/dir-nonconvergence.md';
      const link = 'designs/link-nonconvergence.md';
      writeFileSync(join(root, file), 'design');
      mkdirSync(join(root, dir));
      const outside = join(root, 'outside-nonconvergence.md');
      writeFileSync(outside, 'outside');
      symlinkSync(outside, join(root, link));
      expect(readNonconvergenceDesign(file, { root })).toEqual({ path: file, exists: true });
      for (const path of [dir, link, 'designs/missing-nonconvergence.md']) {
        const despiteDesign = readNonconvergenceDesign(path, { root });
        expect(despiteDesign.exists).toBe(false);
        expect(() => assertRoundGrantAllowed({ ...base, ...override, despiteDesign })).toThrow(/despite/);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('refuses a designs directory symlink pointing outside the root', () => {
    const root = mkdtempSync(join(tmpdir(), 'round-grant-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'round-grant-outside-'));
    try {
      writeFileSync(join(outside, 'x-nonconvergence.md'), 'outside');
      symlinkSync(outside, join(root, 'designs'));
      expect(readNonconvergenceDesign('designs/x-nonconvergence.md', { root }).exists).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
  it('checks real file basenames and path segments before accepting an inside symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'round-grant-target-'));
    try {
      mkdirSync(join(root, 'designs'));
      mkdirSync(join(root, 'designs-other'));
      writeFileSync(join(root, 'designs/ordinary.md'), 'ordinary');
      writeFileSync(join(root, 'designs/real-nonconvergence.md'), 'design');
      writeFileSync(join(root, 'designs-other/real-nonconvergence.md'), 'outside');
      for (const [name, target, exists] of [
        ['wrong', 'designs/ordinary.md', false],
        ['prefix', 'designs-other/real-nonconvergence.md', false],
        ['inside', 'designs/real-nonconvergence.md', true],
      ]) {
        const path = `designs/${name}-nonconvergence.md`;
        symlinkSync(join(root, target), join(root, path));
        expect(readNonconvergenceDesign(path, { root })).toEqual({ path, exists });
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

it('every round extension comment writer imports and calls the shared guard', () => {
  const root = resolve('scripts');
  const writers = [];
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== '__tests__') visit(path); continue; }
      if (!entry.isFile() || entry.name.endsWith('.test.mjs') || path === join(root, 'conveyor/round-extension-mark.mjs')) continue;
      const source = readFileSync(path, 'utf8');
      if (!/\bbuildRoundExtensionComment\s*\(/.test(source)) continue;
      writers.push(relative(root, path));
      expect(source, path).toMatch(/import\s*\{[^}]*\bassertRoundGrantAllowed\b[^}]*\}\s*from\s*['"][^'"]*round-grant-guard\.mjs['"]/);
      expect(source, path).toMatch(/\bassertRoundGrantAllowed\s*\(/);
    }
  }
  visit(root);
  expect(writers).toEqual(expect.arrayContaining(['operations/extend-rounds.mjs', 'conveyor/auto-round-grant-io.mjs']));
});
