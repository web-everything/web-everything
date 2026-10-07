/**
 * @file scripts/operations/__tests__/free-scope-io-real.test.mjs
 * @description The fidelity qualifier (#2949) for `free-scope-io.mjs`: its real mechanisms run for real, separate
 *   from the injected-double suite in `free-scope-io.test.mjs`. The card read walks a REAL committed checkout
 *   (`withRealRepo`), the gh read is a REAL subprocess (an executable stand-in for `gh` on disk, reached through
 *   `execFileSync` exactly as production reaches `gh`), and the registry update takes its REAL mkdir lock and
 *   atomic rename on disk — including two back-to-back updates that must both survive.
 */
import { it, expect } from 'vitest';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectFreeScope, readRegistry, updateRegistry } from '../free-scope-io.mjs';
import { assessFreeScope, registerScope } from '../free-scope.mjs';
import { withRealRepo } from './helpers/real-repo.mjs';

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
