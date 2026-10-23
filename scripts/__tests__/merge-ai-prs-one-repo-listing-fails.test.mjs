/**
 * One repo's failed `gh pr list` must not kill the whole drain pass (live 2026-10-03 23:17Z: frontier-ui failed
 * to resolve and nothing merged in ANY repo). The failed repo is logged and the others proceed; only when every
 * repo fails is it still the exit-4 hard-fail.
 */
import { daemonAppEnv } from './fixtures/daemon-app-env.mjs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openPrPageFixture } from './fixtures/open-pr-page-fixture.mjs';
import { partitionListings } from '../merge-ai-prs.mjs';

const FAKE_GH = `#!/usr/bin/env node
const a = process.argv.slice(2);
const openPrPageFixture = ${openPrPageFixture};
const repo = a.includes('--repo') ? a[a.indexOf('--repo') + 1] : '';
if (a[0] === 'repo' && a[1] === 'view') { process.stdout.write('main'); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'list') {
  const bad = (process.env.GH_FAIL_REPOS || '').split(',').filter(Boolean);
  if (bad.includes('*') || bad.includes(repo)) { process.stderr.write("GraphQL: Could not resolve to a Repository with the name '" + repo + "'.\\n"); process.exit(1); }
  process.stdout.write('[]'); process.exit(0);
}
// The drain's candidate listing reads small GraphQL pages (pr-list-paged.mjs): the repo is in the query text.
if (a[0] === 'api' && a[1] === 'graphql') {
  const q = (a.find((x) => x.startsWith('query=')) || '');
  const m = q.match(/owner:"([^"]+)",name:"([^"]+)"/);
  const r = m ? m[1] + '/' + m[2] : '';
  const bad = (process.env.GH_FAIL_REPOS || '').split(',').filter(Boolean);
  if (bad.includes('*') || bad.includes(r)) { process.stderr.write("GraphQL: Could not resolve to a Repository with the name '" + r + "'.\\n"); process.exit(1); }
  if ((process.env.GH_504_REPOS || '').split(',').includes(r)) { process.stderr.write('HTTP 504: 504 Gateway Timeout (https://api.github.com/graphql)\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify(openPrPageFixture([], q)));
  process.exit(0);
}
process.stdout.write('[]');
`;

describe('partitionListings', () => {
  it('splits usable listings from failed ones', () => {
    const ok = { repo: 'a/a', prs: [], rows: [] };
    const bad = { repo: 'b/b', err: { kind: 'network', text: 'x' } };
    expect(partitionListings([ok, bad])).toEqual({ ok: [ok], failed: [bad] });
    expect(partitionListings(undefined)).toEqual({ ok: [], failed: [] });
  });
});

describe('merge-ai-prs CLI - one failing repo does not kill the pass', () => {
  const script = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'merge-ai-prs.mjs');
  let shimDir; let repoDir;
  beforeAll(() => {
    shimDir = mkdtempSync(join(tmpdir(), 'merge-ai-prs-one-fail-gh-'));
    writeFileSync(join(shimDir, 'gh'), FAKE_GH); chmodSync(join(shimDir, 'gh'), 0o755);
    repoDir = mkdtempSync(join(tmpdir(), 'merge-ai-prs-one-fail-repo-'));
    execFileSync('git', ['init', '-q'], { cwd: repoDir });
    mkdirSync(join(repoDir, 'backlog'), { recursive: true });
  });
  afterAll(() => {
    try { rmSync(shimDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });
  const runCli = (failRepos, gw504Repos = '') => spawnSync('node', [script, '--repos=web-everything/web-everything,frontier-ui/frontierui,plateauapp/plateau-app', '--no-drain-lease', '--no-red-main-freeze', '--json'], {
    cwd: repoDir, encoding: 'utf8',
    env: { ...process.env, ...daemonAppEnv(repoDir), PATH: `${shimDir}:${process.env.PATH}`, GH_FAIL_REPOS: failRepos, GH_504_REPOS: gw504Repos },
  });

  it('frontier-ui failing is reported as failed and the pass still completes', () => {
    const r = runCli('frontier-ui/frontierui');
    expect(r.status, r.stderr).toBe(0);
    const payload = JSON.parse(r.stdout.trim());
    expect(payload.failedRepos).toEqual([expect.objectContaining({ repo: 'frontier-ui/frontierui' })]);
    expect(payload.repos).toContain('plateauapp/plateau-app');
    expect(r.stderr).toMatch(/frontier-ui\/frontierui FAILED to list/);
  });

  it('a 504 on one repo\'s page is a loud, retryable UNREADABLE repo, never 0 candidates', () => {
    const r = runCli('', 'web-everything/web-everything');
    expect(r.status, r.stderr).toBe(0);
    const payload = JSON.parse(r.stdout.trim());
    expect(payload.failedRepos).toEqual([expect.objectContaining({ repo: 'web-everything/web-everything', kind: 'unreadable', retryable: true })]);
    expect(r.stderr).toMatch(/DRAIN LISTING UNREADABLE.*web-everything\/web-everything.*UNKNOWN \(not 0\)/);
  });

  it('every repo failing is still the exit-4 hard-fail', () => {
    const r = runCli('*');
    expect(r.status).toBe(4);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ ok: false, reason: 'gh-error' });
  });
});
