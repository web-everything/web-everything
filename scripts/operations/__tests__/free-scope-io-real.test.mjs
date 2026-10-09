/**
 * @file scripts/operations/__tests__/free-scope-io-real.test.mjs
 * @description The fidelity qualifier (#2949) for `free-scope-io.mjs`: its real mechanisms run for real, separate
 *   from the injected-double suite in `free-scope-io.test.mjs`. The card read walks a REAL committed checkout
 *   (`withRealRepo`), the gh read is a REAL subprocess (an executable stand-in for `gh` on disk, reached through
 *   `execFileSync` exactly as production reaches `gh`), and the registry update takes its REAL mkdir lock and
 *   atomic rename on disk — including two back-to-back updates that must both survive.
 */
import { it, expect } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { collectFreeScope, readRegistry, updateRegistry } from '../free-scope-io.mjs';
import { assessFreeScope, registerScope } from '../free-scope.mjs';
import { withRealRepo, withBareOrigin } from './helpers/real-repo.mjs';

it('reads a committed card scope, a real gh subprocess and the on-disk registry into one verdict', async () => {
  await withRealRepo(({ tmp, root, commit }) => {
    commit({
      'backlog/123-real-card.md': '---\ntitle: "real"\nscope:\n  - we:scripts/a.mjs\n  - we:scripts/lib/\n---\nbody\n',
    }, 'fixture: card');
    const bin = join(tmp, 'gh');
    writeFileSync(bin, `#!/usr/bin/env node
const repo = process.argv[process.argv.indexOf('--repo') + 1];
const rows = repo === 'web-everything/web-everything'
  ? [{ number: 7, title: 'touches lib', url: 'u', files: [{ path: 'scripts/lib/x.mjs' }] }] : [];
process.stdout.write(JSON.stringify(rows));
`);
    chmodSync(bin, 0o755);
    const registryPath = join(tmp, 'coord', 'agent-scopes.json');
    const nowMs = Date.parse('2026-10-05T18:00:00Z');
    updateRegistry(registryPath, (e) => registerScope(e, { agent: 'w1', purpose: 'p', files: ['scripts/a.mjs'] }, new Date(nowMs).toISOString()));
    updateRegistry(registryPath, (e) => registerScope(e, { agent: 'w2', purpose: 'p', files: ['scripts/b.mjs'] }, new Date(nowMs).toISOString()));
    expect(readRegistry(registryPath).map((e) => e.agent)).toEqual(['w1', 'w2']);
    expect(existsSync(`${registryPath}.lock`)).toBe(false);

    const snapshot = collectFreeScope({ card: '123', root, env: { WE_FREE_SCOPE_GH_BIN: bin }, now: () => nowMs, registryPath });
    expect(snapshot.unreadable).toEqual([]);
    const verdict = assessFreeScope(snapshot);
    expect(verdict.status).toBe('occupied');
    const byFile = Object.fromEntries(verdict.files.map((r) => [r.file, r.holders.map((h) => h.number ?? h.agent)]));
    expect(byFile).toEqual({ 'we:scripts/a.mjs': ['w1'], 'we:scripts/lib/': [7] });
  });
});

it('a gh subprocess that fails makes the verdict unknown, never free', async () => {
  await withRealRepo(({ tmp }) => {
    const bin = join(tmp, 'gh-broken');
    writeFileSync(bin, '#!/bin/sh\necho "HTTP 502" >&2\nexit 1\n');
    chmodSync(bin, 0o755);
    mkdirSync(join(tmp, 'coord'), { recursive: true });
    const snapshot = collectFreeScope({ files: 'scripts/z.mjs', env: { WE_FREE_SCOPE_GH_BIN: bin },
      registryPath: join(tmp, 'coord', 'none.json') });
    expect(snapshot.unreadable.length).toBe(2);
    expect(assessFreeScope(snapshot).status).toBe('unknown');
  });
});

// xl5oele (live 2026-10-08): a REAL bare origin with GitHub's `refs/pull/<n>/head` refs, and a fake `gh` whose PR
// file lists are wrong the two ways GitHub's were: stale after a main merge, and cut off at 100 files.
it('reads each PR head against its merge-base with current main, through a real fetch from a real origin', async () => {
  await withBareOrigin(({ tmp, origin, clone, seedOriginBranch }) => {
    const sh = (args) => execFileSync('git', args, { cwd: origin, encoding: 'utf8' }).trim();
    const tipOf = (ref) => sh(['rev-parse', ref]);
    // PR 1 changes a.mjs, then merges main, which meanwhile changed jury-core.mjs (the #4502 shape).
    seedOriginBranch('pr1', { 'scripts/a.mjs': 'a\n' });
    seedOriginBranch('main', { 'scripts/lib/jury-core.mjs': 'main change\n' });
    seedOriginBranch('merged', { 'scripts/a.mjs': 'a\n' }, 'main');
    const merge = sh(['commit-tree', `${tipOf('merged')}^{tree}`, '-p', tipOf('pr1'), '-p', tipOf('main'), '-m', 'merge main']);
    sh(['update-ref', 'refs/pull/1/head', merge]);
    // PR 2 changes 150 files (the #4461 shape); PR 3 truly changes jury-core.mjs.
    seedOriginBranch('pr2', Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`big/f${i}.mjs`, `${i}\n`])));
    sh(['update-ref', 'refs/pull/2/head', tipOf('pr2')]);
    seedOriginBranch('pr3', { 'scripts/lib/jury-core.mjs': 'real change\n' });
    sh(['update-ref', 'refs/pull/3/head', tipOf('pr3')]);
    const rows = [
      { number: 1, title: 'merged main', url: 'u', headRefOid: merge, files: [{ path: 'scripts/a.mjs' }, { path: 'scripts/lib/jury-core.mjs' }] },
      { number: 2, title: 'big', url: 'u', headRefOid: tipOf('pr2'), files: Array.from({ length: 100 }, (_, i) => ({ path: `big/f${i}.mjs`, changeType: 'ADDED' })) },
      { number: 3, title: 'real', url: 'u', headRefOid: tipOf('pr3'), files: [{ path: 'scripts/lib/jury-core.mjs' }] },
    ];
    const bin = join(tmp, 'gh-stale');
    writeFileSync(bin, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'api') { process.stderr.write('HTTP 502\\n'); process.exit(1); }
const repo = args[args.indexOf('--repo') + 1];
process.stdout.write(repo === 'web-everything/web-everything' ? ${JSON.stringify(JSON.stringify(rows))} : '[]');
`);
    chmodSync(bin, 0o755);
    mkdirSync(join(tmp, 'coord'), { recursive: true });
    const collect = (files) => collectFreeScope({ files, root: clone, env: { WE_FREE_SCOPE_GH_BIN: bin, HOME: tmp },
      registryPath: join(tmp, 'coord', 'none.json'), gitDirFor: (repo) => (repo === 'web-everything/web-everything' ? clone : null) });
    const snapshot = collect('scripts/lib/jury-core.mjs,big/f120.mjs,scripts/elsewhere.mjs');
    // Before this fix: #1 held jury-core.mjs and #2's 100-file list made the whole verdict UNKNOWN.
    expect(snapshot.unreadable).toEqual([]);
    expect(Object.fromEntries(snapshot.prs.map((p) => [p.number, [p.source, p.files.length]]))).toEqual({ 1: ['git', 1], 2: ['git', 150], 3: ['git', 1] });
    expect(snapshot.prs.find((p) => p.number === 2).added).toHaveLength(150);
    const verdict = assessFreeScope(snapshot);
    expect(verdict.files.map((r) => [r.file, r.state, r.holders.map((h) => h.number)])).toEqual([
      ['we:scripts/lib/jury-core.mjs', 'occupied', [3]],
      ['we:big/f120.mjs', 'occupied', [2]],
      ['we:scripts/elsewhere.mjs', 'free', []],
    ]);
    // A head git cannot fetch falls back to gh: an uncapped list is used as-is, a capped one is UNKNOWN.
    rows[0].headRefOid = '0'.repeat(40);
    rows[1].headRefOid = '1'.repeat(40);
    writeFileSync(bin, readFileSync(bin, 'utf8').replace(/process\.stdout\.write\(.*\n/, `process.stdout.write(repo === 'web-everything/web-everything' ? ${JSON.stringify(JSON.stringify(rows))} : '[]');\n`));
    const degraded = collect('scripts/elsewhere.mjs');
    expect(degraded.prs.map((p) => p.source)).toEqual(['github-list', 'github-list-capped', 'git']);
    expect(degraded.unreadable).toHaveLength(1);
    expect(degraded.unreadable[0].error).toMatch(/PR #2 git: .*; github api: HTTP 502; lists 100 files/);
    expect(assessFreeScope(degraded).status).toBe('unknown');
  });
});
