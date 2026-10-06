/**
 * @file scripts/operations/__tests__/free-scope-io.test.mjs
 * @description Filesystem and CLI probes with a private registry and executable fake gh. No real host
 * or home state is read or written; fixtures exercise the same subprocess and YAML boundaries as production.
 */
import { beforeEach, afterEach, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { defaultRegistryPath, readRegistry, writeRegistry, updateRegistry, ghExec, readOpenPrs, findCardFile, readCardScope, collectFreeScope } from '../free-scope-io.mjs';
import { main } from '../free-scope-cli.mjs';
let root, registry, env;
const now = () => Date.parse('2026-10-05T10:00:00Z');
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'free-scope-'));
  registry = path.join(root, 'state', 'agents.json');
  const gh = path.join(root, 'gh');
  fs.writeFileSync(gh, `#!/usr/bin/env node
const args = process.argv.slice(2);
const repo = args[args.indexOf('--repo') + 1];
if (repo === 'bad/repo') { process.stderr.write('unavailable\\n'); process.exit(1); }
const full = Array.from({length: Number(args[args.indexOf('--limit') + 1])}, (_, i) => ({number: i + 1, title: 'P', url: 'u', files: [{path: 'f' + i + '.mjs'}]}));
const twin = [{number: 12, title: 'Twin ' + repo, url: 'u', files: [{path: 'twin.mjs'}]}];
const fixture = [{number: 12, title: 'Fixture', url: 'https://example.test/12', files: [{path: 'held.mjs'}]}];
const capped = [{number: 7, title: 'Capped', url: 'u', files: Array.from({length: 100}, (_, i) => ({path: 'c' + i + '.mjs'}))}];
console.log(JSON.stringify(repo === 'full/repo' ? full : repo === 'capped/repo' ? capped : require('node:fs').existsSync(__filename + '.twins') ? twin : repo === 'fixture/repo' ? fixture : []));
`, { mode: 0o755 });
  env = { WE_AGENT_SCOPES_PATH: registry, WE_FREE_SCOPE_GH_BIN: gh };
  fs.mkdirSync(path.join(root, 'backlog'));
  fs.writeFileSync(path.join(root, 'backlog/123-some-card.md'), '---\nscope:\n  - we:card.mjs\n  - plateau:other.mjs\n---\n');
  fs.writeFileSync(path.join(root, 'backlog/1234-other.md'), '---\nscope: scalar.mjs\n---\n');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
it('reads missing, bare and wrapped registries, refusing corruption', () => {
  expect(defaultRegistryPath(env)).toBe(registry);
  expect(readRegistry(registry)).toEqual([]);
  fs.mkdirSync(path.dirname(registry));
  fs.writeFileSync(registry, '[{"agent":"a"}]');
  expect(readRegistry(registry)).toEqual([{ agent: 'a' }]);
  writeRegistry(registry, [{ agent: 'b' }]);
  expect(readRegistry(registry)).toEqual([{ agent: 'b' }]);
  expect(fs.readdirSync(path.dirname(registry))).toEqual(['agents.json']);
  fs.writeFileSync(registry, '{bad');
  expect(() => readRegistry(registry)).toThrow(registry);
  fs.writeFileSync(registry, '{}');
  expect(() => readRegistry(registry)).toThrow(registry);
});
it('updates under a lock, steals stale locks and cleans up on callback failure', () => {
  updateRegistry(registry, () => [{ agent: 'a' }]);
  fs.mkdirSync(`${registry}.lock`);
  fs.utimesSync(`${registry}.lock`, new Date(0), new Date(0));
  updateRegistry(registry, (entries) => [...entries, { agent: 'b' }]);
  expect(readRegistry(registry)).toHaveLength(2);
  expect(() => updateRegistry(registry, () => { throw new Error('failed'); })).toThrow('failed');
  expect(fs.existsSync(`${registry}.lock`)).toBe(false);
  expect(readRegistry(registry)).toHaveLength(2);
});
it('reads real fake-gh subprocess output and retains failures per repo', () => {
  const result = readOpenPrs({ repos: ['bad/repo', 'fixture/repo'], exec: ghExec(env) });
  expect(result.prs).toEqual([{ repo: 'fixture/repo', number: 12, title: 'Fixture', url: 'https://example.test/12', files: ['held.mjs'] }]);
  expect(result.unreadable).toHaveLength(1);
  expect(result.unreadable[0].repo).toBe('bad/repo');
  expect(result.unreadable[0].error).not.toContain('\n');
});
it('treats a full page of open PRs as unreadable, so a truncated snapshot is never free', () => {
  const result = readOpenPrs({ repos: ['full/repo', 'fixture/repo'], exec: ghExec(env) });
  expect(result.unreadable).toHaveLength(1);
  expect(result.unreadable[0]).toMatchObject({ repo: 'full/repo' });
  expect(result.unreadable[0].error).toMatch(/200/);
  expect(result.prs.filter((p) => p.repo === 'fixture/repo')).toHaveLength(1);
  const collect = (options) => collectFreeScope({ ...options, repos: ['full/repo'] });
  const verdict = cli(['--files=untouched.mjs', '--json'], { collect });
  expect(verdict.code).toBe(2);
  expect(JSON.parse(verdict.out)).toMatchObject({ status: 'unknown', unreadable: [{ repo: 'full/repo' }] });
  const seen = cli(['--files=repo:f3.mjs', '--json'], { collect });
  expect(seen.code).toBe(1);
  expect(JSON.parse(seen.out).status).toBe('occupied');
});
it('treats a PR whose file list is at the gh cap as unreadable, so its unlisted files are never free', () => {
  const result = readOpenPrs({ repos: ['capped/repo', 'fixture/repo'], exec: ghExec(env) });
  expect(result.unreadable).toHaveLength(1);
  expect(result.unreadable[0]).toMatchObject({ repo: 'capped/repo' });
  expect(result.unreadable[0].error).toMatch(/PR #7.*100 files/);
  expect(result.prs.filter((p) => p.repo === 'capped/repo')[0].files).toHaveLength(100);
  const collect = (options) => collectFreeScope({ ...options, repos: ['capped/repo'] });
  const beyond = cli(['--files=c150.mjs', '--json'], { collect });
  expect(beyond.code).toBe(2);
  const verdict = JSON.parse(beyond.out);
  expect(verdict.status).toBe('unknown');
  expect(verdict.files).toMatchObject([{ file: 'we:c150.mjs', state: 'unknown', free: false }]);
  const text = cli(['--files=c150.mjs'], { collect });
  expect(text.out).not.toMatch(/\bFREE\b/);
  expect(JSON.parse(cli(['--files=repo:c3.mjs', '--json'], { collect }).out).status).toBe('occupied');
  expect(readOpenPrs({ repos: ['fixture/repo'], exec: ghExec(env) }).unreadable).toEqual([]);
});
it('qualifies --exclude-pr by repo through the CLI', () => {
  // Both default repos report an open PR #12 touching the same file.
  fs.writeFileSync(path.join(root, 'gh.twins'), '');
  const twin = (extra) => cli(['--files=twin.mjs,plateau-app:twin.mjs', '--json', ...extra]);
  const holders = (result) => JSON.parse(result.out).files.map((row) => row.holders.map((h) => h.repo));
  const defaulted = twin(['--exclude-pr=12']);
  expect(defaulted.code).toBe(1);
  expect(holders(defaulted)).toEqual([[], ['plateauapp/plateau-app']]);
  const plateau = twin(['--exclude-pr=plateau-app#12']);
  expect(plateau.code).toBe(1);
  expect(holders(plateau)).toEqual([['web-everything/web-everything'], []]);
  expect(holders(twin([]))).toEqual([['web-everything/web-everything'], ['plateauapp/plateau-app']]);
  expect(cli(['--files=x.mjs', '--exclude-pr=nope#3']).code).toBe(2);
});
it('matches exact card IDs and combines qualified scope with CLI files', () => {
  expect(findCardFile('#123', { root })).toBe(path.join(root, 'backlog/123-some-card.md'));
  expect(findCardFile('12', { root })).toBeNull();
  expect(readCardScope('1234', { root })).toEqual(['scalar.mjs']);
  expect(() => readCardScope('12', { root })).toThrow('not found');
  fs.writeFileSync(path.join(root, 'backlog/4-empty.md'), '---\ntitle: Empty\n---\n');
  expect(() => readCardScope('4', { root })).toThrow('no scope');
  const result = collectFreeScope({ files: './extra.mjs,we:card.mjs', card: '#123', root, env, now });
  expect(result).toMatchObject({ files: ['we:extra.mjs', 'we:card.mjs', 'plateau-app:other.mjs'], nowMs: now(), agents: [], prs: [], unreadable: [] });
});
function cli(args, extra = {}) {
  let out = '', err = '';
  const code = main(args, { env, now, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, ...extra });
  return { code, out, err };
}
it('registers, checks, excludes, lists and releases via the CLI', () => {
  expect(cli(['--register', '--agent=build-x', '--purpose=build', '--files=x.mjs']).code).toBe(0);
  const held = cli(['check', '--files=x.mjs']);
  expect(held.code).toBe(1);
  expect(held.out).toContain('OCCUPIED  we:x.mjs  ← agent build-x');
  expect(cli(['--files=x.mjs', '--exclude-agent=build-x']).code).toBe(0);
  expect(JSON.parse(cli(['list', '--json']).out).live[0].agent).toBe('build-x');
  const conflicting = cli(['register', '--agent=other', '--files=x.mjs', '--json']);
  expect(conflicting.code).toBe(1);
  expect(JSON.parse(conflicting.out).registered.agent).toBe('other');
  expect(cli(['release', '--agent=other']).out).toBe('released 1\n');
  expect(cli(['release', '--agent=build-x']).out).toBe('released 1\n');
  expect(cli(['--release', '--agent=build-x']).code).toBe(0);
  expect(cli(['--files=x.mjs']).code).toBe(0);
});
it('reports unknown, refuses bad usage and keeps help side effect free', () => {
  const collect = (options) => collectFreeScope({ ...options, repos: ['bad/repo'] });
  expect(cli(['--files=x.mjs', '--json'], { collect }).code).toBe(2);
  for (const args of [[], ['register', '--files=x.mjs'], ['--bogus'], ['--files=x.mjs', '--exclude-pr=bad'], ['register', '--agent=x', '--files=x.mjs', '--ttl-hours=0']]) expect(cli(args).code).toBe(2);
  expect(cli(['--help'], { collect: () => { throw new Error('must not collect'); } }).code).toBe(0);
  expect(fs.existsSync(registry)).toBe(false);
  const out = execFileSync(process.execPath, ['scripts/operations/run.mjs', 'free-scope', '--help'], { encoding: 'utf8', env: { ...process.env, ...env, WE_FREE_SCOPE_GH_BIN: '/nonexistent-gh' } });
  expect(out).toContain('read(compute) → assess(compute)');
});
