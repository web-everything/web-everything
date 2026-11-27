import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const url = rel => pathToFileURL(join(root, rel)).href;
// Prefer the actual last-good daemon script. Some lane clones lack this historical file.
const historical = spawnSync('git', ['show',
  'c20bd31fc1bd1b0b6942c60ef5e879052336fe9b:scripts/lib/daemon-live-smoke.mjs'],
{ cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
// Minimal c20bd31 fix row: notably NO readPushHold/readFixClaim/readHistoryInputs stubs.
const fallback = `record('fix', 900002, () => {
  let captured = null;
  const spawn = argv => { captured = argv[argv.length - 1]; return 'stub-fix-900002'; };
  dispatchFix({ itemNum: null, pr: 900002, laneRef: 'lane/900002-smoke-fix',
    scope: ['we:scripts/lib/daemon-live-smoke.mjs'], lane: 90101, headRefOid: null },
    { repo: 'we', spawnAgent: spawn, extraArgs: [], acquireClaim: noopAcquire,
      releaseClaim: noopRelease, recordAdvisor: () => {} });
  checkFilled(captured, 'fix PR #900002', canonicalPlaceholder, BRIEF_REQUIRED_BY_KIND.fix);
});`;

// Decode the old generated-script string lines without importing its daemon module (whose
// relative imports would resolve against the wrong tree). Run just its real direct fix row.
let oldFixRow = fallback;
if (historical.status === 0) {
  const script = historical.stdout.split('\n').flatMap(line => {
    const literal = line.trim().replace(/,$/, '');
    if (!literal.startsWith('"') || !literal.endsWith('"')) return [];
    try { return [JSON.parse(literal)]; } catch { return []; }
  }).join('\n');
  const start = script.indexOf("record('fix', 900002");
  const end = script.indexOf('// 3a. ci-heal', start);
  if (start < 0 || end < 0) throw Error('missing historical fix row');
  oldFixRow = script.slice(start, end);
}

function probe({ marker = '', liveClaim = false, wrapFix = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-skew-'));
  const env = { ...process.env, TMPDIR: dir, WE_COORDINATION_ROOT: join(dir, 'coordination') };
  delete env.VITEST;
  delete env.WE_UNDER_TEST;
  if (marker === null) delete env.WE_SMOKE_DRYRUN_ONLY;
  else env.WE_SMOKE_DRYRUN_ONLY = marker;
  const child = `
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    let spawned = 0, ghReads = 0, outcome, handle;
    for (const method of ['execFileSync', 'spawnSync']) {
      const original = cp[method];
      cp[method] = (file, ...args) => {
        if (/(?:^|[/])gh$/.test(String(file))) { ghReads++; throw Error('failing gh port'); }
        return original(file, ...args);
      };
    }
    syncBuiltinESMExports();
    const { dispatchFix: realDispatch } = await import(${JSON.stringify(url('scripts/conveyor/reconcile-fix-dispatch.mjs'))});
    import { checkFilled } from ${JSON.stringify(url('scripts/lib/daemon-live-smoke.mjs'))};
    import { launchWrappedClaudeWorker } from ${JSON.stringify(url('scripts/operations/worker-wrapper-launch.mjs'))};
    import { acquireFixClaim } from ${JSON.stringify(url('scripts/conveyor/fix-procedure.mjs'))};
    if (${liveClaim}) {
      const claim = acquireFixClaim({ repo: 'we', pr: 900002, who: 'old-smoke-fixture' });
      if (!claim.ok) throw Error('could not plant claim');
    }
    const dispatchFix = (planned, options) => realDispatch(planned, {
      root: process.cwd(), readBrief: () => '{{PR_NUM}} {{LANE_REF}} {{LANE}} {{SESSION_SLUG}} {{SCOPE}}',
      // Keep the candidate DEFAULT claim/history/hold readers; only inject the failing gh port.
      fixSettings: { roundHistory: 'on' }, stampExecutor: () => {}, postNotice: () => {},
      executorDecision: { executor: 'claude', mode: 'direct' },
      wrapFix: ${wrapFix}, grantConflictHelper: () => {}, advisorFor: () => ({ enabled: false }),
      sessionCwdFor: () => process.cwd(), ensureSessionCwd: p => p,
      isolateSession: () => ({}), resolveSettingsEnv: () => null,
      readPushHoldOptions: { run: () => { ghReads++; throw Error('failing gh port'); } },
      launchWrapped: request => {
        const result = launchWrappedClaudeWorker({ ...request, allowRealSentinel: false,
          launch: () => { throw Error('must never launch'); } });
        handle = result.handle;
        return result;
      },
      ...options, spawnAgent: (...args) => { spawned++; return options.spawnAgent(...args); },
    });
    const row = ${JSON.stringify(oldFixRow)};
    new Function('record', 'dispatchFix', 'noopAcquire', 'noopRelease', 'checkFilled',
      'canonicalPlaceholder', 'BRIEF_REQUIRED_BY_KIND', row)(
      (kind, pr, fn) => { try { fn(); outcome = { ok: true }; }
        catch (e) { outcome = { ok: false, error: e.message }; } },
      dispatchFix, () => ({ ok: true }), () => {}, checkFilled, x => x, { fix: [] });
    process.stdout.write(JSON.stringify({ spawned, ghReads, outcome, handle }));
  `;
  try {
    const childResult = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
      cwd: dir, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    });
    expect(childResult.status, childResult.stderr).toBe(0);
    return JSON.parse(childResult.stdout);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('old c20bd31 smoke script + post-9513de58 dispatchFix', () => {
  it('passes the old row with an empty smoke marker and a failing gh port, without calling gh', () => {
    expect(probe()).toEqual({ spawned: 1, ghReads: 0, outcome: { ok: true } });
  });
  it('ignores a live sentinel fix claim only in the marked smoke context', () => {
    expect(probe({ liveClaim: true })).toEqual({ spawned: 1, ghReads: 0, outcome: { ok: true } });
  });
  it('without the marker still reads live and fails the old row with no prompt captured', () => {
    const report = probe({ marker: null });
    expect(report.ghReads).toBeGreaterThan(0);
    expect(report).toMatchObject({ spawned: 0, ghReads: expect.any(Number),
      outcome: { ok: false, error: expect.stringContaining('no prompt captured') } });
  });
  it('a marked sentinel with wrapFix:true still returns the refused sentinel launch handle', () => {
    expect(probe({ wrapFix: true })).toMatchObject({ spawned: 0, ghReads: 0,
      handle: 'refused:smoke-sentinel-900002', outcome: { ok: false } });
  });
});
