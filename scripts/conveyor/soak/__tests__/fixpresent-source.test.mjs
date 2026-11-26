import { describe, test, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { validateBreakShape } from '../breaks-shape.mjs';
import * as harness from '../define-break-test.mjs';
import { markerBreak, fixedSource, brokenSource } from '../fixtures/fixpresent-marker.mjs';

const registered = vi.hoisted(() => []);
vi.mock('vitest', async importOriginal => {
  const actual = await importOriginal();
  const it = (title, run) => registered.push({ title, run, fails: false });
  it.fails = (title, run) => registered.push({ title, run, fails: true });
  return { ...actual, describe: (_title, register) => register(), it };
});
const roots = [];
function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'fixpresent-'));
  roots.push(root);
  return root;
}
afterEach(() => { registered.length = 0; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const strict = b => validateBreakShape(b, 'fixture.mjs', { legacy: 'reject' });

describe('declared fix presence', () => {
  test.each([true, false])('refuses a legacy behavioural probe returning %s without executing it', present => {
    const root = tempRoot(), b = markerBreak(root);
    b.fixPresent = vi.fn(() => present);
    expect(() => harness.defineBreakTest(b, { root })).toThrow(/marker-fixture.*fixPresent.*marker.*fixCommit/);
    expect(b.fixPresent).not.toHaveBeenCalled();
    expect(registered).toEqual([]);
  });

  test('an absent commit requires a completed failing judge verdict; setup and import errors fail', async () => {
    const root = tempRoot();
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
    git('init', '-q'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'fixture');
    writeFileSync(join(root, 'value'), 'before'); git('add', '.'); git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD').trim();
    writeFileSync(join(root, 'value'), 'after'); git('add', '.'); git('commit', '-qm', 'fix');
    const fixCommit = git('rev-parse', 'HEAD').trim();
    git('checkout', '-q', '--detach', base);
    const b = { ...markerBreak(root), fixPresent: { fixCommit }, run: async () => 'broken' };
    const execute = async descriptor => {
      registered.length = 0;
      harness.defineBreakTest(descriptor, { root });
      const registration = registered[0];
      // Reproduce Vitest's expected-failure semantics, rather than just calling its callback.
      try { await registration.run(); }
      catch (error) { if (!registration.fails) throw error; return; }
      if (registration.fails) throw new Error('unexpected pass');
    };
    await expect(execute(b)).resolves.toBeUndefined();
    for (const message of ['setup failed', 'module import failed']) {
      await expect(execute({ ...b, run: async () => { throw new Error(message); } })).rejects.toThrow(message);
    }
    await expect(execute({ ...b, judge: () => { throw new Error('judge crashed'); } })).rejects.toThrow('judge crashed');
    await expect(execute({ ...b, judge: () => undefined })).rejects.toThrow();
    await expect(execute({ ...b, judge: () => [] })).rejects.toThrow();
  });

  test('a break whose fixPresent calls the code under test is rejected', () => {
    const b = markerBreak(tempRoot());
    b.fixPresent = () => b.judge('fixed').length === 0;
    expect(() => strict(b)).toThrow(/fixPresent.*marker.*fixCommit/);
  });

  test.each([{ marker: 'fix.mjs#soakFix' }, { fixCommit: 'deadbeef' }])('accepts declared source %j', fixPresent => {
    const b = { ...markerBreak(tempRoot()), fixPresent };
    expect(strict(b)).toBe(b);
  });

  test.each([undefined, null, {}, { marker: '' }, { fixCommit: 'HEAD' },
    { marker: '../fix.mjs#soakFix' }, { marker: 'fix.mjs#soakFix', fixCommit: 'deadbeef' }])('rejects incomplete or ambiguous evidence %j', fixPresent => {
    expect(() => strict({ ...markerBreak(tempRoot()), fixPresent })).toThrow(/fixPresent/);
  });

  test('removing both halves of a fix makes the soak fail, not pass', async () => {
    const root = tempRoot(), b = markerBreak(root);
    writeFileSync(join(root, 'fix.mjs'), fixedSource);
    harness.defineBreakTest(b, { root });
    expect(registered[0].fails).toBe(false);
    await registered[0].run();
    registered.length = 0;
    writeFileSync(join(root, 'fix.mjs'), brokenSource);
    expect(() => harness.defineBreakTest(b, { root })).toThrow(/marker.*missing/i);
    expect(registered).toEqual([]);
    expect(b.judge(await b.run())).toEqual(['fix removed']);
  });

  test('keeping the marker cannot hide a behavioural regression', async () => {
    const root = tempRoot();
    writeFileSync(join(root, 'fix.mjs'), `export const soakFix = true; ${brokenSource}`);
    harness.defineBreakTest(markerBreak(root), { root });
    expect(registered[0].fails).toBe(false);
    await expect(registered[0].run()).rejects.toThrow();
  });

  test.each(['// export const soakFix = true;', 'const text = "export const soakFix = true;";', 'export const = ;'])('does not accept a comment, string or unreadable module as marker: %s', source => {
    const root = tempRoot();
    writeFileSync(join(root, 'fix.mjs'), source);
    expect(() => harness.defineBreakTest(markerBreak(root), { root })).toThrow();
    expect(registered).toEqual([]);
  });

  test('missing marker module fails closed', () => {
    expect(() => harness.defineBreakTest(markerBreak(tempRoot()), { root: tempRoot() })).toThrow();
    expect(registered).toEqual([]);
  });

  test('fixCommit ancestry falls back to patch-id, and refuses when neither matches', () => {
    const root = tempRoot();
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
    git('init', '-q'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'fixture');
    writeFileSync(join(root, 'value'), 'before\n'); git('add', '.'); git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD').trim();
    writeFileSync(join(root, 'value'), 'after\n'); git('add', '.'); git('commit', '-qm', 'fix');
    const fixCommit = git('rev-parse', 'HEAD').trim();
    expect(harness.resolveFixPresent({ fixCommit }, root)).toBe(true);
    git('checkout', '-q', '--detach', base);
    expect(harness.resolveFixPresent({ fixCommit }, root)).toBe(false);
    writeFileSync(join(root, 'value'), 'after\n'); git('add', '.'); git('commit', '-qm', 'equivalent fix');
    expect(git('rev-parse', 'HEAD').trim()).not.toBe(fixCommit);
    expect(harness.resolveFixPresent({ fixCommit }, root)).toBe(true);
    expect(() => harness.resolveFixPresent({ fixCommit: 'a'.repeat(40) }, root)).toThrow(/evidence/i);
  });
});
