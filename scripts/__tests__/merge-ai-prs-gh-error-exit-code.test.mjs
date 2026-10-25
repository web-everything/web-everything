/**
 * @file scripts/__tests__/merge-ai-prs-gh-error-exit-code.test.mjs
 * @description #3383 — the `gh pr list` listing failure (bad env / auth / rate-limit) used to overload exit 3,
 *   the SAME code the #2318 duplicate-NNN-on-main tripwire uses. The resident drain daemon treats every exit 3
 *   as "duplicate NNN on main" and backs off 15 minutes — so a transient/rate-limited `gh` listing was silently
 *   misread as the loud duplicate-id tripwire. This gives the listing failure its own exit code (4), keeps the
 *   `{ok:false, reason:'gh-error', detail}` payload, and leaves the duplicate tripwire on exit 3 unchanged.
 *   Drives the REAL CLI entrypoint (`runCli` is not exported — it only runs under the `IS_CLI` guard), with a
 *   fake `gh` on PATH so no network/real `gh` is touched, following the `review-set-label.test.mjs` shim pattern.
 */
import { daemonAppEnv } from './fixtures/daemon-app-env.mjs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

// A minimal `gh` stub: `repo view --json defaultBranchRef` → "main"; `pr list` → `[]`, unless
// GH_FAIL_LIST=1, which fails it the way a rate-limited/unauthenticated `gh` does (non-zero exit + stderr).
// Anything else (there is nothing else on this bare, unlabelled, no-candidate sweep) → a harmless `[]`.
const FAKE_GH = `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === 'repo' && a[1] === 'view') { process.stdout.write('main'); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'list') {
  if (process.env.GH_FAIL_LIST === '1') { process.stderr.write('GraphQL: API rate limit already exceeded for installation ID 1.\\n'); process.exit(1); }
  if (process.env.GH_FAIL_LIST === 'auth') { process.stderr.write('HTTP 401: Bad credentials (https://api.github.com/graphql)\\n'); process.exit(1); }
  process.stdout.write('[]');
  process.exit(0);
}
process.stdout.write('[]');
process.exit(0);
`;

describe('merge-ai-prs CLI — #3383 gh-error exit code split from the dup-id tripwire', () => {
  const script = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'merge-ai-prs.mjs');
  let shimDir;
  let repoDir;

  beforeAll(() => {
    shimDir = mkdtempSync(join(tmpdir(), 'merge-ai-prs-gh-shim-'));
    writeFileSync(join(shimDir, 'gh'), FAKE_GH);
    chmodSync(join(shimDir, 'gh'), 0o755);
    // A throwaway git repo (no real remote reached — localRepoSlug() fails soft to null on a bad/absent
    // origin) so the CLI's own `git remote get-url origin` probe never touches the real webeverything checkout.
    repoDir = mkdtempSync(join(tmpdir(), 'merge-ai-prs-gh-repo-'));
    execFileSync('git', ['init', '-q'], { cwd: repoDir });
    mkdirSync(join(repoDir, 'backlog'), { recursive: true });
  });
  afterAll(() => {
    try { rmSync(shimDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  // `--this-repo` keeps the sweep to the one (fake) cwd repo — no constellation fan-out, one `gh pr list` call.
  // `--no-drain-lease` + `--no-red-main-freeze` bypass the two unrelated gates (#2449 whole-process lease,
  // #2681 red-main stop-the-line) that would otherwise touch this machine's real `~/.claude/drain-locks` state
  // ahead of the listing/tripwire code under test.
  const runCli = (extraEnv = {}) => spawnSync('node', [script, '--this-repo', '--no-drain-lease', '--no-red-main-freeze', '--json'], {
    cwd: repoDir,
    encoding: 'utf8',
    env: { ...process.env, ...daemonAppEnv(repoDir), PATH: `${shimDir}:${process.env.PATH}`,
      WE_GH_THROTTLE_LOCK_ROOT: join(repoDir, `throttle-${randomUUID()}`),
      WE_GH_THROTTLE_GH_BIN: join(shimDir, 'gh'), WE_GH_THROTTLE_RETRY_MAX_ATTEMPTS: '1', ...extraEnv },
  });

  it('a `gh pr list` failure exits 4 with reason:gh-error, distinct from the dup-id tripwire\'s exit 3', () => {
    const r = runCli({ GH_FAIL_LIST: '1' });
    expect(r.status).toBe(4);
    const payload = JSON.parse(r.stdout.trim());
    expect(payload).toMatchObject({ ok: false, reason: 'gh-error' });
    expect(payload.detail).toMatch(/gh pr list/);
    // 2026-09-27 — the drain logged only "Command failed: gh pr list …" for 4 passes in a row: gh's own stderr
    // (the actual reason) was cut by `.split('\n')[0]`. The detail must carry it, classified.
    expect(payload.detail).toMatch(/API rate limit already exceeded for installation ID 1/);
    expect(payload.detail).toMatch(/rate-limited/);
    expect(payload.detail).not.toMatch(/is gh authenticated\?/);
  });

  it('an auth failure keeps the "is gh authenticated?" hint and carries gh\'s own stderr', () => {
    const r = runCli({ GH_FAIL_LIST: 'auth' });
    expect(r.status).toBe(4);
    const payload = JSON.parse(r.stdout.trim());
    expect(payload.detail).toMatch(/HTTP 401: Bad credentials/);
    expect(payload.detail).toMatch(/is gh authenticated\?/);
    // gh's own stderr cause reaches the detail (2026-09-27 freeze: a bare "Command failed" hid a rate-limit storm) —
    // now via main's classified `describeGhListError` (`[kind]: <gh stderr line>`), which superseded #2794's
    // `ghListErrText` last-stderr-line format when the two met in the merge.
    expect(payload.detail).toMatch(/failed \[auth\]: HTTP 401: Bad credentials/);
  });

  it('a clean gh listing (no error) exits 0 when the backlog carries no duplicate ids', () => {
    const r = runCli();
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout.trim());
    expect(payload.ok).toBe(true);
    expect(payload.duplicateIdsOnMain).toBeUndefined();
  });

  it('the #2318 duplicate-NNN-on-main tripwire is UNCHANGED — still exits 3, never 4', () => {
    writeFileSync(join(repoDir, 'backlog', '100-a.md'), '');
    writeFileSync(join(repoDir, 'backlog', '100-b.md'), '');
    try {
      const r = runCli();
      expect(r.status).toBe(3);
      const payload = JSON.parse(r.stdout.trim());
      expect(payload.ok).toBe(false);
      expect(payload.duplicateIdsOnMain).toEqual([{ num: '100', names: ['100-a.md', '100-b.md'] }]);
    } finally {
      rmSync(join(repoDir, 'backlog', '100-a.md'), { force: true });
      rmSync(join(repoDir, 'backlog', '100-b.md'), { force: true });
    }
  });
});
