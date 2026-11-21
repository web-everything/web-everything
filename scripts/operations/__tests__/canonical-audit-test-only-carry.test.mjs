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
const BASE = 'b'.repeat(40);

// origin/main is a base commit; the audited head adds a feature and one test file on top of it.
function makeRepo({ withOrigin = true } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'test-only-carry-'));
  git(repo, 'init', '-q');
  mkdirSync(join(repo, 'src/__tests__'), { recursive: true });
  writeFileSync(join(repo, 'README.md'), 'base\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  if (withOrigin) git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
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
const addFile = (path, body = "it('new', () => {\n  expect(2).toBe(2);\n});\n") => r => { mkdirSync(dirname(join(r, path)), { recursive: true }); writeFileSync(join(r, path), body); };
const rec = (head, verdict = 'NOT WEAKENED') => ({ head, base: BASE, questionHash: QUESTION_HASH, at: '2026-11-17T00:00:00Z', verdict, findings: verdict === 'WEAKENED' ? ['f'] : [] });

function gate(repo, head, records, { warn = () => {}, exec = execFileSync } = {}) {
  const text = records.map(r => JSON.stringify(r)).join('\n');
  const enoent = () => { const e = new Error('missing'); e.code = 'ENOENT'; throw e; };
  const readFile = (path) => {
    if (path === WRITER_SETTINGS) return JSON.stringify({ auditRecordPath: '~/audit.jsonl' });
    if (path === '/fixture-prefs') return JSON.stringify({ prototypeLoad: {} });
    if (path === '/fixture-home/audit.jsonl') return text;
    return enoent();
  };
  return checkCanonicalAuditForOpen({ repo, ref: 'lane/x', sha: head, env: { ...process.env, HOME: '/fixture-home', WE_PLATFORM_PREFERENCES_FILE: '/fixture-prefs' },
    readFile, exec, fetchMain: () => {}, ancestor: () => true, warn, now: () => Date.parse('2026-11-20T20:00:00Z') });
}

describe('test-only additive delta carries the canonical audit', () => {
  it('test-only additive delta carries the canonical audit (new test files only)', () => {
    const { repo, audited } = makeRepo();
    const head = follow(repo, r => { addFile('src/__tests__/b.test.mjs')(r); addFile('src/c.test.ts')(r); });
    expect(testOnlyAdditiveDelta(repo, audited, head)).toMatchObject({ ok: true });
    const logs = [];
    const result = gate(repo, head, [rec(audited)], { warn: m => logs.push(m) });
    expect(result).toMatchObject({ ok: true, sha: head, carried: { head: audited } });
    expect(logs).toEqual([expect.stringMatching(new RegExp(`^carried: test-only additive delta ${audited}\\.\\.${head} \\(.*ET\\)$`))]);
  });

  const refused = (name, edit, reason) => it(`refuses ${name}`, () => {
    const { repo, audited } = makeRepo();
    const head = follow(repo, edit);
    expect(testOnlyAdditiveDelta(repo, audited, head)).toMatchObject({ ok: false, ...(reason ? { reason: expect.stringContaining(reason) } : {}) });
    expect(gate(repo, head, [rec(audited)])).toMatchObject({ ok: false, reason: 'canonical-audit-missing' });
  });
  // One negative per audit finding: edits to existing files (zero-deletion weakening, markers, context-completed markers)
  refused('an append to an existing test (return; / comments / matcher override)', r => writeFileSync(join(r, 'src/__tests__/a.test.mjs'), "it('a', () => {\n  return;\n  expect(1).toBe(1);\n});\n"), 'unexpected');
  refused('a pure line addition to an existing test', r => writeFileSync(join(r, 'src/__tests__/a.test.mjs'), "it('a', () => {\n  expect(1).toBe(1);\n});\nit('a2', () => {});\n"), 'unexpected');
  refused('an edit adding skip to an existing test', r => writeFileSync(join(r, 'src/__tests__/a.test.mjs'), "it.skip('a', () => {\n  expect(1).toBe(1);\n});\n"), 'unexpected');
  refused('a deleted test file', r => git(r, 'rm', '-q', 'src/__tests__/a.test.mjs'), 'unexpected');
  refused('a test-like .js file outside __tests__ (data module)', addFile('src/_data/admission.test.js'), 'non-test');
  refused('a non-test path alongside a new test', r => { addFile('src/__tests__/b.test.mjs')(r); addFile('src/other.mjs', 'export const y = 2;\n')(r); }, 'non-test');
  refused('a new vitest setup file', addFile('src/__tests__/setup.test.mjs'), 'non-test');
  refused('a new vitest config file', addFile('vitest.config.test.mjs', 'export default {};\n'), 'non-test');
  refused('a new non-test helper under __tests__', addFile('src/__tests__/helper.mjs'), 'non-test');
  refused('a new symlink test file', r => symlinkSync('code.mjs', join(r, 'src/__tests__/l.test.mjs')), 'mode');

  it('refuses when the audited head is not an ancestor', () => {
    const { repo, audited } = makeRepo();
    const head = follow(repo, addFile('src/__tests__/b.test.mjs'));
    git(repo, 'checkout', '-q', '-b', 'side', audited);
    const sibling = follow(repo, addFile('src/__tests__/c.test.mjs'));
    expect(testOnlyAdditiveDelta(repo, sibling, head)).toMatchObject({ ok: false, reason: 'not-ancestor' });
    expect(gate(repo, head, [rec(sibling)])).toMatchObject({ ok: false });
  });

  it('refuses when ancestry or the diff cannot be read (any git error)', () => {
    const { repo, audited } = makeRepo();
    const head = follow(repo, addFile('src/__tests__/b.test.mjs'));
    expect(testOnlyAdditiveDelta('/nonexistent-repo-path', audited, 'c'.repeat(40))).toMatchObject({ ok: false });
    expect(testOnlyAdditiveDelta('/x', 'a'.repeat(40), 'b'.repeat(40), { exec: () => { throw Object.assign(new Error('boom'), { status: 128 }); } })).toMatchObject({ ok: false, reason: 'git-failure' });
    expect(testOnlyAdditiveDelta('/x', 'zz', 'b'.repeat(40))).toMatchObject({ ok: false, reason: 'bad-shas' });
    // gate: a status-128 ancestry lookup must refuse, not read as "not an ancestor"
    const failing = (cmd, args, opts) => {
      if (args.includes('--is-ancestor')) throw Object.assign(new Error('fatal'), { status: 128 });
      return execFileSync(cmd, args, opts);
    };
    expect(gate(repo, head, [rec(audited)], { exec: failing })).toMatchObject({ ok: false });
  });

  it('recomputes the ancestor fingerprint (refuses when origin/main is unknown)', () => {
    const { repo, audited } = makeRepo({ withOrigin: false });
    const head = follow(repo, addFile('src/__tests__/b.test.mjs'));
    expect(gate(repo, head, [{ ...rec(audited), fingerprint: 'a'.repeat(64) }])).toMatchObject({ ok: false });
  });

  it('never carries over a WEAKENED verdict, on the audited head or inside the delta', () => {
    const { repo, audited } = makeRepo();
    const mid = follow(repo, addFile('src/__tests__/b.test.mjs'));
    const head = follow(repo, addFile('src/__tests__/c.test.mjs'));
    expect(gate(repo, head, [rec(audited, 'WEAKENED')])).toMatchObject({ ok: false });
    expect(gate(repo, head, [rec(audited), rec(mid, 'WEAKENED')])).toMatchObject({ ok: false });
    expect(gate(repo, head, [rec(audited), rec(mid, 'WEAKENED'), rec(audited)])).toMatchObject({ ok: false });
    expect(gate(repo, head, [rec(audited), rec(head)]).carried).toBeUndefined();
  });
});
