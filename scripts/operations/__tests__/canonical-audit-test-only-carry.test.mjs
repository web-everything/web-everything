import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCanonicalAuditForOpen } from '../canonical-audit-gate.mjs';
import { QUESTION_HASH } from '../codex-audit.mjs';
import { testOnlyAdditiveDelta } from '../../lib/net-diff-fingerprint.mjs';

const WRITER_SETTINGS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'settings', 'prototype-load.json');
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (repo, ...args) => String(execFileSync('git', ['-C', repo, ...args], { env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'test-only-carry-'));
  git(repo, 'init', '-q');
  mkdirSync(join(repo, 'src/__tests__'), { recursive: true });
  writeFileSync(join(repo, 'src/code.mjs'), 'export const x = 1;\n');
  writeFileSync(join(repo, 'src/__tests__/a.test.mjs'), "it('a', () => {\n  expect(1).toBe(1);\n});\n");
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'audited');
  return { repo, audited: git(repo, 'rev-parse', 'HEAD') };
}
function follow(repo, edit) {
  edit(repo);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'follow-up');
  return git(repo, 'rev-parse', 'HEAD');
}
const addTest = (name, body = "it('new', () => {\n  expect(2).toBe(2);\n});\n") => r => writeFileSync(join(r, 'src/__tests__', name), body);

function gate(repo, auditedHead, head, { warn = () => {}, records } = {}) {
  const rec = { head: auditedHead, base: 'b'.repeat(40), questionHash: QUESTION_HASH, at: '2026-11-17T00:00:00Z', verdict: 'NOT WEAKENED', findings: [] };
  const text = (records ?? [rec]).map(r => JSON.stringify(r)).join('\n');
  const enoent = () => { const e = new Error('missing'); e.code = 'ENOENT'; throw e; };
  const readFile = (path) => {
    if (path === WRITER_SETTINGS) return JSON.stringify({ auditRecordPath: '~/audit.jsonl' });
    if (path === '/fixture-prefs') return JSON.stringify({ prototypeLoad: {} });
    if (path === '/fixture-home/audit.jsonl') return text;
    return enoent();
  };
  return checkCanonicalAuditForOpen({ repo, ref: 'lane/x', sha: head, env: { HOME: '/fixture-home', WE_PLATFORM_PREFERENCES_FILE: '/fixture-prefs' },
    readFile, fetchMain: () => {}, ancestor: () => true, liveFingerprint: () => null, warn, now: () => Date.parse('2026-11-20T20:00:00Z') });
}

describe('test-only additive delta carries the canonical audit', () => {
  it('test-only additive delta carries the canonical audit (new file and appended lines)', () => {
    const { repo, audited } = makeRepo();
    const head = follow(repo, r => { addTest('b.test.mjs')(r); writeFileSync(join(r, 'src/__tests__/a.test.mjs'), "it('a', () => {\n  expect(1).toBe(1);\n});\nit('a2', () => {\n  expect(3).toBe(3);\n});\n"); });
    expect(testOnlyAdditiveDelta(repo, audited, head)).toMatchObject({ ok: true });
    const logs = [];
    const result = gate(repo, audited, head, { warn: m => logs.push(m) });
    expect(result).toMatchObject({ ok: true, sha: head, carried: { head: audited } });
    expect(logs).toEqual([expect.stringMatching(new RegExp(`^carried: test-only additive delta ${audited}\\.\\.${head} \\(.*ET\\)$`))]);
  });

  const refused = (name, edit, reason) => it(`refuses ${name}`, () => {
    const { repo, audited } = makeRepo();
    const head = follow(repo, edit);
    expect(testOnlyAdditiveDelta(repo, audited, head)).toMatchObject({ ok: false, ...(reason ? { reason: expect.stringContaining(reason) } : {}) });
    expect(gate(repo, audited, head)).toMatchObject({ ok: false, reason: 'canonical-audit-missing' });
  });
  refused('a changed expect line', r => writeFileSync(join(r, 'src/__tests__/a.test.mjs'), "it('a', () => {\n  expect(1).toBe(2);\n});\n"), 'deleted');
  refused('a deleted expect line', r => writeFileSync(join(r, 'src/__tests__/a.test.mjs'), "it('a', () => {\n});\n"), 'deleted');
  refused('an added .skip', addTest('b.test.mjs', "it.skip('x', () => {});\n"), 'weakening');
  refused('an added .only', addTest('b.test.mjs', "it.only('x', () => {});\n"), 'weakening');
  refused('an added .todo', addTest('b.test.mjs', "it.todo('x');\n"), 'weakening');
  refused('a non-test path alongside tests', r => { addTest('b.test.mjs')(r); writeFileSync(join(r, 'src/code.mjs'), 'export const x = 1;\nexport const y = 2;\n'); }, 'non-test');
  refused('a vitest setup file', addTest('setup.test.mjs'), 'non-test');
  refused('a vitest config file', r => writeFileSync(join(r, 'vitest.config.test.mjs'), 'export default {};\n'), 'non-test');
  refused('a non-test helper under __tests__', addTest('helper.mjs'), 'non-test');
  refused('a symlink test file', r => symlinkSync('code.mjs', join(r, 'src/__tests__/l.test.mjs')), 'mode');
  refused('a file deletion', r => git(r, 'rm', '-q', 'src/__tests__/a.test.mjs'), 'unexpected');

  it('refuses when the audited head is not an ancestor', () => {
    const { repo, audited } = makeRepo();
    const head = follow(repo, addTest('b.test.mjs'));
    git(repo, 'checkout', '-q', '-b', 'side', audited);
    const sibling = follow(repo, addTest('c.test.mjs'));
    expect(testOnlyAdditiveDelta(repo, sibling, head)).toMatchObject({ ok: false, reason: 'not-ancestor' });
    expect(gate(repo, sibling, head)).toMatchObject({ ok: false });
  });

  it('refuses when the diff cannot be read', () => {
    const { audited } = makeRepo();
    expect(testOnlyAdditiveDelta('/nonexistent-repo-path', audited, 'c'.repeat(40))).toMatchObject({ ok: false });
    expect(testOnlyAdditiveDelta('/x', 'a'.repeat(40), 'b'.repeat(40), { exec: () => { throw new Error('boom'); } })).toMatchObject({ ok: false, reason: 'not-ancestor' });
    expect(testOnlyAdditiveDelta('/x', 'zz', 'b'.repeat(40))).toMatchObject({ ok: false, reason: 'bad-shas' });
  });

  it('never carries over a WEAKENED verdict on the audited head', () => {
    const { repo, audited } = makeRepo();
    const head = follow(repo, addTest('b.test.mjs'));
    const weak = { head: audited, base: 'b'.repeat(40), questionHash: QUESTION_HASH, at: '2026-11-17T00:00:00Z', verdict: 'WEAKENED', findings: ['f'] };
    expect(gate(repo, audited, head, { records: [weak] })).toMatchObject({ ok: false });
  });
});
