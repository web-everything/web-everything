/**
 * @file scripts/operations/__tests__/free-scope-cli.test.mjs
 * @description A stacked PR's base chain (live 2026-10-09: #4643 and #4658, both holding the builder files a PR
 * stacked on them edits) must be excludable together. `--exclude-pr` is repeatable and takes a comma list, for
 * `check` and `register` alike. The snapshot reader is injected; the registry is a private temp file.
 */
import { beforeEach, afterEach, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../free-scope-cli.mjs';

let root, env;
const now = () => Date.parse('2026-10-09T19:00:00Z');
// Every PR touches the same WE file; the plateau-app one names it repo-qualified (a cross-repo scope).
const pr = (number, repo = 'web-everything/web-everything') => ({ number, repo, title: `PR ${number}`, url: 'u', files: ['we:held.mjs'] });
const collect = ({ files }) => ({ files: String(files).split(','), nowMs: now(), unreadable: [], agents: [],
  prs: [pr(4643), pr(4658), pr(4658, 'plateauapp/plateau-app')] });
const run = (argv) => {
  let out = '', err = '';
  const code = main(argv, { env, now, collect, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } });
  return { code, out, err };
};
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'free-scope-cli-'));
  env = { WE_AGENT_SCOPES_PATH: path.join(root, 'agents.json') };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

it('one --exclude-pr leaves the rest of a base chain holding the file', () => {
  const r = run(['check', '--files=held.mjs', '--exclude-pr=4643']);
  expect(r.code).toBe(1);
  expect(r.out).toContain('PR #4658');
});

it('repeated --exclude-pr excludes every named PR on check', () => {
  const r = run(['check', '--files=held.mjs', '--exclude-pr=4643', '--exclude-pr=4658', '--exclude-pr=plateau-app#4658']);
  expect(r.err).toBe('');
  expect(r.code).toBe(0);
  expect(r.out).toContain('all 1 files free');
});

it('a comma list works the same, and a repo-qualified number only excludes that repo', () => {
  const r = run(['check', '--files=held.mjs', '--exclude-pr=4643,4658', '--json']);
  expect(r.code).toBe(1);
  const v = JSON.parse(r.out);
  expect(v.files[0].holders.map((h) => `${h.repo}#${h.number}`)).toEqual(['plateauapp/plateau-app#4658']);
});

it('register accepts the same exclusions and records the scope', () => {
  const r = run(['register', '--agent=stacked', '--owner=o1', '--purpose=p', '--files=held.mjs',
    '--exclude-pr=4643', '--exclude-pr=4658,plateau-app#4658']);
  expect(r.code).toBe(0);
  const entries = JSON.parse(fs.readFileSync(env.WE_AGENT_SCOPES_PATH, 'utf8'));
  expect((entries.entries ?? entries).map((e) => e.agent)).toContain('stacked');
});

it('a malformed entry in the list is refused', () => {
  const r = run(['check', '--files=held.mjs', '--exclude-pr=4643,nope']);
  expect(r.code).toBe(2);
  expect(r.err).toMatch(/--exclude-pr must be/);
});
