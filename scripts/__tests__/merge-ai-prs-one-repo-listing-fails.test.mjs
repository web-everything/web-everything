/**
 * One repo's failed `gh pr list` must not kill the whole drain pass (live 2026-10-03 23:17Z: frontier-ui failed
 * to resolve and nothing merged in ANY repo). The failed repo is logged and the others proceed; only when every
 * repo fails is it still the exit-4 hard-fail.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { partitionListings } from '../merge-ai-prs.mjs';

const FAKE_GH = `#!/usr/bin/env node
const a = process.argv.slice(2);
const repo = a.includes('--repo') ? a[a.indexOf('--repo') + 1] : '';
if (a[0] === 'repo' && a[1] === 'view') { process.stdout.write('main'); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'list') {
  const bad = (process.env.GH_FAIL_REPOS || '').split(',').filter(Boolean);
  if (bad.includes('*') || bad.includes(repo)) { process.stderr.write("GraphQL: Could not resolve to a Repository with the name '" + repo + "'.\\n"); process.exit(1); }
  process.stdout.write('[]'); process.exit(0);
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
  const runCli = (failRepos) => spawnSync('node', [script, '--repos=web-everything/web-everything,frontier-ui/frontierui,plateauapp/plateau-app', '--no-drain-lease', '--no-red-main-freeze', '--json'], {
    cwd: repoDir, encoding: 'utf8',
    env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, GH_FAIL_REPOS: failRepos },
  });

  it('frontier-ui failing is reported as failed and the pass still completes', () => {
    const r = runCli('frontier-ui/frontierui');
    expect(r.status, r.stderr).toBe(0);
    const payload = JSON.parse(r.stdout.trim());
    expect(payload.failedRepos).toEqual([expect.objectContaining({ repo: 'frontier-ui/frontierui' })]);
    expect(payload.repos).toContain('plateauapp/plateau-app');
    expect(r.stderr).toMatch(/frontier-ui\/frontierui FAILED to list/);
  });

  it('every repo failing is still the exit-4 hard-fail', () => {
    const r = runCli('*');
    expect(r.status).toBe(4);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ ok: false, reason: 'gh-error' });
  });
});
