import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

// Resolve filesystem paths first so Vite cannot rewrite the child's imports to HTTP asset URLs.
const testDir = dirname(fileURLToPath(import.meta.url));

describe('dispatch dry-run smoke live hold isolation', () => {
  it('the actual synthetic fix call spawns with test flags removed and a failing gh port', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smoke-push-hold-'));
    const env = { ...process.env };
    delete env.VITEST;
    delete env.WE_UNDER_TEST;
    const child = `
      import { dispatchFix as realDispatch } from ${JSON.stringify(pathToFileURL(join(testDir, '../../conveyor/reconcile-fix-dispatch.mjs')).href)};
      import { DISPATCH_DRY_RUN_SCRIPT } from ${JSON.stringify(pathToFileURL(join(testDir, '../daemon-live-smoke.mjs')).href)};
      let spawned = 0, ghReads = 0, outcome;
      const dispatchFix = (planned, options) => realDispatch(planned, {
        root: process.cwd(), readBrief: () => '{{PR_NUM}} {{LANE_REF}} {{LANE}} {{SESSION_SLUG}} {{SCOPE}}',
        readFixClaim: () => null, readHistoryInputs: () => null, stampExecutor: () => {},
        postNotice: () => {}, wrapFix: false, grantConflictHelper: () => {}, advisorFor: () => ({ enabled: false }),
        sessionCwdFor: () => process.cwd(), ensureSessionCwd: p => p,
        isolateSession: () => ({}), resolveSettingsEnv: () => null,
        readPushHoldOptions: { run: () => { ghReads++; throw Error('failing gh stub'); } },
        ...options, spawnAgent: (...args) => { spawned++; return options.spawnAgent(...args); },
      });
      const start = DISPATCH_DRY_RUN_SCRIPT.indexOf("record('fix', 900002");
      const end = DISPATCH_DRY_RUN_SCRIPT.indexOf('// 3a. ci-heal', start);
      if (start < 0 || end < 0) throw Error('missing synthetic fix call');
      const invoke = new Function('record', 'dispatchFix', 'noopAcquire', 'noopRelease',
        'checkFilled', 'canonicalPlaceholder', 'BRIEF_REQUIRED_BY_KIND', DISPATCH_DRY_RUN_SCRIPT.slice(start, end));
      invoke((kind, pr, fn) => { try { fn(); outcome = { ok: true }; } catch (e) { outcome = { ok: false, error: e.message }; } },
        dispatchFix, () => ({ ok: true }), () => {}, () => {}, x => x, { fix: [] });
      process.stdout.write(JSON.stringify({ spawned, ghReads, outcome }));
    `;
    try {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
        cwd: dir, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ spawned: 1, ghReads: 0, outcome: { ok: true } });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
