/**
 * Card xx7ckd6 — the red-main hold, exercised through the REAL drain CLI with hermetic git/gh shims (the #4389
 * isolation harness shared with merge-ai-prs-merge-queue-hook-wiring.test.mjs). That harness passes
 * `--no-red-main-freeze`, which bypasses the hold entirely; THIS file runs WITHOUT it, so the wiring that replaced the
 * manual freeze's unconditional stop (the per-PR hold block in `sweepOnce`, the `redMainFreezeStop` early return, the
 * legacy-marker migration) is defended at the `gh pr merge` call: a held PR must never reach it.
 * The child env clears VITEST/WE_UNDER_TEST, because the record readers return null under them.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'merge-ai-prs.mjs');
const remediation = join(dirname(fileURLToPath(import.meta.url)), '..', 'readiness', 'red-main-remediation.mjs');
const NOW = Date.now();
const FUTURE = NOW + 30 * 60_000;

const fakeGh = `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
const F = process.env.RMH_FIXTURE;
const prs = JSON.parse(fs.readFileSync(F, 'utf8'));
const landed = n => fs.existsSync(F + '.merged-' + n);
const out = x => { process.stdout.write(JSON.stringify(x)); process.exit(0); };
if (a[0] === 'repo' && a[1] === 'view') { process.stdout.write('main'); process.exit(0); }
// RMH_LATE_FREEZE: the operator raises the freeze DURING the pass (after the drain's pre-pass freeze check).
if (a[0] === 'pr' && a[1] === 'list' && process.env.RMH_LATE_FREEZE && !fs.existsSync(process.env.RMH_LATE_FREEZE)) {
  fs.writeFileSync(process.env.RMH_LATE_FREEZE, JSON.stringify({ frozen: true, at: new Date().toISOString(), reason: 'raised mid-pass' }));
}
if (a[0] === 'pr' && a[1] === 'list') out(prs.filter(p => !landed(p.number)));
if (a[0] === 'pr' && a[1] === 'view') {
  const p = prs.find(p => String(p.number) === a[2]);
  if (!p) process.exit(1);
  out({ ...p, state: landed(p.number) ? 'MERGED' : 'OPEN', mergedAt: landed(p.number) ? '2026-10-09T00:00:00Z' : null });
}
if (a[0] === 'pr' && a[1] === 'merge') { fs.appendFileSync(F + '.attempts', a[2] + '\\n'); fs.writeFileSync(F + '.merged-' + a[2], ''); process.exit(0); }
if (a[0] === 'api') {
  const path = a[1];
  if (/\\/branches\\/main$/.test(path)) out({ sha: 'tip' });
  if (/compare\\//.test(path)) out({ base: 'base', ahead: 0, files: [], n: 0 });
  if (/pulls\\/(\\d+)\\/files/.test(path)) out([[]]);
  if (/check-runs/.test(path)) out([{ check_runs: [] }]);
}
process.exit(0);
`;
const fakeGit = `#!/usr/bin/env node
const a = process.argv.slice(2);
// RMH_STRANDED: a checkout attached to main whose origin/main log delivers open card 7001, so the drain's stranded-card
// sweep resolves it and pushes the flip to main. Every git call is logged, so a test can see any write to main.
const S = process.env.RMH_STRANDED;
if (S) {
  require('node:fs').appendFileSync(S, a.join(' ') + '\\n');
  const say = (s) => { process.stdout.write(s + '\\n'); process.exit(0); };
  if (a[0] === 'symbolic-ref') say('main');
  if (a[0] === 'rev-parse' && a[1] === 'HEAD') say('feedface');
  if (a[0] === 'log' && a.includes('--pretty=%s') && a.includes('origin/main')) say('WE #7001: the stranded delivery (#7001)');
  if (a[0] === 'ls-files' && /^backlog\\/7001-/.test(a[1] || '')) say('backlog/7001-stranded-card.md');
}
if (a[0] === 'remote' && a[1] === 'get-url') process.stdout.write('git@github.com:fixture/drain-rmh.git\\n');
if (a[0] === 'diff') process.exit(1);
process.exit(0);
`;

const FIX = 3001; // the published main-fix PR
const OTHER = 3002; // an unrelated PR that is otherwise fully mergeable

/**
 * @param {{ freeze?: 'env'|'legacy'|'both'|null, priorityPrs?: number[]|null, publishedRed?: boolean, holdSetting?: 'on'|'off'|null,
 *           fixMergeable?: string, unfreezeFirst?: boolean, dryRun?: boolean, stranded?: boolean, lateFreeze?: boolean }} o
 */
function runCli({ freeze = null, priorityPrs = null, publishedRed = false, holdSetting = null, fixMergeable = 'MERGEABLE', unfreezeFirst = false, dryRun = false, stranded = false, lateFreeze = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'drain-rmh-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    for (const [name, code] of [['gh', fakeGh], ['git', fakeGit]]) writeFileSync(join(bin, name), code, { mode: 0o755 });
    const fixture = join(dir, 'prs.json');
    writeFileSync(fixture, JSON.stringify([FIX, OTHER].map((number) => ({
      number, title: `leaf ${number}`, body: 'A real summary.', headRefName: `lane/leaf-${number}`,
      baseRefName: 'main', headRefOid: `sha-${number}`, mergeable: number === FIX ? fixMergeable : 'MERGEABLE', mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS', status: 'COMPLETED' }],
      labels: [{ name: 'ready-to-merge' }], comments: [],
      commits: [{ oid: `sha-${number}`, authors: [{ name: 'Claude', email: 'noreply@anthropic.com' }] }],
      files: [{ path: `backlog/leaf-${number}.md`, additions: 1, deletions: 0 }],
    }))));
    const coord = join(dir, 'coord');
    mkdirSync(coord, { recursive: true });
    const marker = { frozen: true, at: new Date(NOW).toISOString(), reason: 'fixture red', redRef: 'main', mergeSha: 'abc1234567', revertAuthority: true };
    const newMarker = join(coord, 'red-main-freeze.json');
    const legacyMarker = join(dir, 'legacy', 'red-main-freeze.json');
    const envMarker = join(dir, 'explicit-freeze.json');
    if (freeze === 'env') writeFileSync(envMarker, JSON.stringify(marker));
    if (freeze === 'legacy' || freeze === 'both') { mkdirSync(dirname(legacyMarker), { recursive: true }); writeFileSync(legacyMarker, JSON.stringify(marker)); }
    // 'sibling': the freeze was raised from ANOTHER clone (the drain daemon's code clone), not the one running the pass.
    const siblingMarker = join(dir, 'workspace', '.lanes', 'we-drain-daemon', 'code', '.conveyor', 'red-main-freeze.json');
    if (freeze === 'sibling') { mkdirSync(dirname(siblingMarker), { recursive: true }); writeFileSync(siblingMarker, JSON.stringify(marker)); }
    if (freeze === 'both') writeFileSync(newMarker, JSON.stringify({ ...marker, reason: 'raised at the new path' }));
    if (priorityPrs) writeFileSync(join(coord, 'main-red-priority.json'), JSON.stringify({ repo: 'we', pr: priorityPrs[0], prs: priorityPrs, firstRedSha: 'abc1234567', expiresAt: FUTURE }));
    if (publishedRed) writeFileSync(join(coord, 'main-ci-red-state.json'), JSON.stringify({ red: true, firstRedSha: 'abc1234567', since: NOW - 60_000, setAt: NOW, expiresAt: FUTURE }));
    // The merge-queue/freshness hook is a separate gate (its own wiring test); with VITEST cleared the live ON file would
    // be read and refuse these fixture PRs (facts-incomplete), so pin it OFF to isolate the red-main hold.
    const mqSettings = join(dir, 'merge-queue.json');
    writeFileSync(mqSettings, JSON.stringify({ mergeQueue: { enabled: false }, mergeFreshness: { enabled: false } }));
    const preload = 'data:text/javascript,' + encodeURIComponent("import os from 'node:os'; import { syncBuiltinESMExports } from 'node:module'; os.homedir = () => process.env.RMH_HOME; syncBuiltinESMExports();");
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, RMH_FIXTURE: fixture, RMH_HOME: dir, WE_COORDINATION_ROOT: coord,
      ...(freeze === 'sibling' ? {} : { WE_RED_MAIN_FREEZE_LEGACY: legacyMarker }), WE_MERGE_QUEUE_SETTINGS_FILE: mqSettings,
      WE_RED_MAIN_FREEZE_SHARED: 'off' }; // VITEST is cleared below, so the unfreeze CLI must not push the live shared ops branch (xyd06qo)
    if (freeze === 'sibling') delete env.WE_RED_MAIN_FREEZE_LEGACY;
    const gitLog = join(dir, 'git-calls.log');
    if (stranded) { // an open card whose delivery is already on main: the stranded-card sweep's job is to resolve + push it
      mkdirSync(join(dir, 'backlog'));
      writeFileSync(join(dir, 'backlog', '7001-stranded-card.md'), '---\nid: 7001\ntitle: stranded\nstatus: open\nkind: story\n---\n');
      mkdirSync(join(dir, 'scripts'));
      writeFileSync(join(dir, 'scripts', 'backlog.mjs'), 'process.exit(0);\n'); // `backlog.mjs resolve` succeeds
      env.RMH_STRANDED = gitLog;
    }
    for (const k of ['VITEST', 'WE_UNDER_TEST', 'WE_MERGE_BREAK_GLASS', 'WE_RED_MAIN_FREEZE', 'WE_DRAIN_RED_MAIN_HOLD', 'WE_DRAIN_RED_MAIN_MODE']) delete env[k];
    if (freeze === 'env') env.WE_RED_MAIN_FREEZE = envMarker;
    if (lateFreeze) { env.WE_RED_MAIN_FREEZE = envMarker; env.RMH_LATE_FREEZE = envMarker; } // written by the fake gh mid-pass
    // Pin the hold + mode: with VITEST cleared the live scripts/settings/red-main-hold.json would otherwise be read.
    env.WE_DRAIN_RED_MAIN_HOLD = holdSetting || 'on';
    env.WE_DRAIN_RED_MAIN_MODE = 'stop';
    if (unfreezeFirst) { // the operator lifts the freeze through the real remediation CLI BEFORE the drain pass
      const u = spawnSync(process.execPath, ['--import', preload, remediation, 'unfreeze'], { cwd: dir, encoding: 'utf8', timeout: 30000, env });
      expect(u.status, u.stderr).toBe(0);
    }
    const r = spawnSync(process.execPath, ['--import', preload, script, '--this-repo', '--label=ready-to-merge',
      '--no-reconcile-labels', '--no-drain-lease', '--json', ...(dryRun ? ['--dry-run'] : [])], { cwd: dir, encoding: 'utf8', timeout: 30000, env });
    expect(r.error, r.stderr).toBeUndefined();
    const lines = r.stdout.trim().split('\n').filter(Boolean);
    const result = lines.length ? JSON.parse(lines.at(-1)) : null;
    const attempts = existsSync(fixture + '.attempts') ? readFileSync(fixture + '.attempts', 'utf8').trim().split('\n').filter(Boolean).map(Number) : [];
    const gitCalls = existsSync(gitLog) ? readFileSync(gitLog, 'utf8').trim().split('\n').filter(Boolean) : [];
    // Any push whose target is main, however spelled (`HEAD:main`, `<sha>:refs/heads/main`, bare `main`, extra flags).
    const mainPushes = gitCalls.filter((l) => /^push\b/.test(l) && l.split(' ').slice(1).some((t) => /^(?:[^:\s]*:)?(?:refs\/heads\/)?main$/.test(t)));
    return { status: r.status, result, stderr: r.stderr, attempts, mainPushes, newMarkerExists: existsSync(newMarker),
      legacyGone: !existsSync(legacyMarker),
      legacyAside: ['migrated', 'superseded', 'retired'].find((s) => existsSync(`${legacyMarker}.${s}`)) ?? null,
      siblingAside: ['migrated', 'superseded', 'retired'].find((s) => existsSync(`${siblingMarker}.${s}`)) ?? null, siblingGone: !existsSync(siblingMarker),
      migratedFrom: existsSync(newMarker) ? JSON.parse(readFileSync(newMarker, 'utf8')).migratedFrom ?? null : null, legacyMarker };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('card xx7ckd6 — red-main hold wired at the drain merge site (no --no-red-main-freeze)', () => {
  it('control: main not red → both PRs merge', () => {
    const { attempts, status, stderr } = runCli();
    expect(attempts.sort(), stderr).toEqual([FIX, OTHER]);
    expect(status).toBe(0);
  }, 30000);

  it('manual freeze + published fix PR (hold ON by default): only the fix PR reaches gh pr merge; the other is a red-main-hold skip', () => {
    const { attempts, stderr, status } = runCli({ freeze: 'env', priorityPrs: [FIX] });
    expect(attempts).toEqual([FIX]);
    expect(status).not.toBe(5); // the old whole-line stop is NOT what contains it
    expect(stderr).toMatch(/skipped 1: #3002 red-main-hold/);
  }, 30000);

  it('a published red alone (no manual freeze) also holds the unrelated PR while the fix PR lands', () => {
    const { attempts, stderr } = runCli({ publishedRed: true, priorityPrs: [FIX] });
    expect(attempts).toEqual([FIX]);
    expect(stderr).toMatch(/\[published\] — only the main-fix PR #3001 lands/);
  }, 30000);

  it('red but NO fix PR published yet: nothing lands (no PR is exempt)', () => {
    const { attempts, stderr } = runCli({ freeze: 'env' });
    expect(attempts).toEqual([]);
    expect(stderr).toMatch(/skipped 2: #3001 red-main-hold, #3002 red-main-hold/);
    expect(stderr).toMatch(/nothing lands \(no main-fix PR published yet\)/);
  }, 30000);

  it('the hold only ADDS: a fix PR that fails another merge gate (not mergeable) is not merged, and the other stays held', () => {
    const { attempts } = runCli({ freeze: 'env', priorityPrs: [FIX], fixMergeable: 'CONFLICTING' });
    expect(attempts).toEqual([]);
  }, 30000);

  it('setting OFF restores the old full stop: a manual freeze exits 5 and nothing — not even the fix PR — reaches gh pr merge', () => {
    const { attempts, status, result } = runCli({ freeze: 'env', priorityPrs: [FIX], holdSetting: 'off' });
    expect(status).toBe(5);
    expect(attempts).toEqual([]);
    expect(result.stopped).toBe('red-main-freeze');
  }, 30000);

  it('setting OFF: a published red alone holds nothing (behaviour before the card)', () => {
    const { attempts } = runCli({ publishedRed: true, priorityPrs: [FIX], holdSetting: 'off' });
    expect(attempts.sort()).toEqual([FIX, OTHER]);
  }, 30000);

  it('rollout: a freeze that exists ONLY at the legacy per-clone path is carried to the coordination root and still holds', () => {
    const { attempts, newMarkerExists, legacyGone, legacyAside, migratedFrom, stderr, status } = runCli({ freeze: 'legacy' });    expect(newMarkerExists).toBe(true);
    expect(legacyGone).toBe(true);
    expect(legacyAside).toBe('migrated');
    expect(migratedFrom).toMatch(/legacy\/red-main-freeze\.json$/);
    expect(stderr).toMatch(/red-main freeze marker migrated/);
    expect(attempts).toEqual([]); // frozen, no fix PR published → nothing lands (a fully held pass is a clean exit, not a stop)
    expect(status).toBe(0);
  }, 30000);

  it('rollout (PR #4624 review): a freeze raised from a SIBLING clone (the daemon code clone) is carried across and still holds the line', () => {
    const { attempts, newMarkerExists, siblingGone, siblingAside, migratedFrom, stderr } = runCli({ freeze: 'sibling' });
    expect(newMarkerExists, stderr).toBe(true);
    expect(siblingGone).toBe(true);
    expect(siblingAside).toBe('migrated');
    expect(migratedFrom).toMatch(/we-drain-daemon\/code\/\.conveyor\/red-main-freeze\.json$/);
    expect(attempts).toEqual([]);
  }, 30000);

  it('a sibling clone\'s freeze does not resurface after `unfreeze` through the real CLI', () => {
    const { attempts, siblingAside, newMarkerExists } = runCli({ freeze: 'sibling', unfreezeFirst: true });
    expect(siblingAside).toBe('retired');
    expect(newMarkerExists).toBe(false);
    expect(attempts.sort()).toEqual([FIX, OTHER]);
  }, 30000);

  it('an old marker can never resurface after `unfreeze`: legacy + new both present → unfreeze → both PRs land', () => {
    const { attempts, legacyGone, legacyAside, newMarkerExists } = runCli({ freeze: 'both', unfreezeFirst: true });
    expect(newMarkerExists).toBe(false);
    expect(legacyGone).toBe(true);
    expect(legacyAside).toBe('retired');
    expect(attempts.sort()).toEqual([FIX, OTHER]);
  }, 30000);

  it('legacy only → unfreeze (before any drain pass migrated it) → both PRs land, nothing is carried across', () => {
    const { attempts, newMarkerExists, legacyAside } = runCli({ freeze: 'legacy', unfreezeFirst: true });
    expect(legacyAside).toBe('retired');
    expect(newMarkerExists).toBe(false);
    expect(attempts.sort()).toEqual([FIX, OTHER]);
  }, 30000);

  it('legacy + a newer marker at the new path, no unfreeze: the new path wins, the legacy file is set aside, the line stays held', () => {
    const { attempts, legacyAside, migratedFrom } = runCli({ freeze: 'both' });
    expect(legacyAside).toBe('superseded');
    expect(migratedFrom).toBeNull();
    expect(attempts).toEqual([]);
  }, 30000);

  it('--dry-run is read-only: a legacy-only marker is NOT moved', () => {
    const { legacyGone, newMarkerExists, attempts } = runCli({ freeze: 'legacy', dryRun: true });
    expect(legacyGone).toBe(false);
    expect(newMarkerExists).toBe(false);
    expect(attempts).toEqual([]);
  }, 30000);

  // PR #4624 review (merge-ai-prs.mjs:6251): the old freeze stop exited before the pass, so NOTHING reached main. With
  // the hold ON the pass runs, so every OTHER write to main in it must be held too, not only `gh pr merge`.
  it('control: main not red → the stranded-card sweep resolves card 7001 and pushes it to main', () => {
    const { mainPushes, stderr } = runCli({ stranded: true });
    expect(mainPushes, stderr).toEqual(['push origin HEAD:main']);
  }, 30000);

  it('manual freeze (hold ON): the pass writes nothing to main, so the stranded-card sweep does not push; it waits for green', () => {
    const { mainPushes, attempts, status, stderr, result } = runCli({ freeze: 'env', stranded: true });
    expect(attempts).toEqual([]);
    expect(status).not.toBe(5);
    expect(mainPushes, stderr).toEqual([]);
    expect(result.strandedSweep).toMatchObject({ skipped: 'red-main-hold', applied: [], autoResolvable: [{ id: '7001' }] });
  }, 30000);

  it('manual freeze + published fix PR: only the fix PR lands; the stranded-card sweep still does not push', () => {
    const { mainPushes, attempts, stderr, result } = runCli({ freeze: 'env', priorityPrs: [FIX], stranded: true });
    expect(attempts).toEqual([FIX]);
    expect(mainPushes, stderr).toEqual([]);
    expect(result.strandedSweep).toMatchObject({ skipped: 'red-main-hold', applied: [] });
  }, 30000);

  it('a published red alone (hold ON) also keeps the stranded-card sweep off main', () => {
    const { mainPushes, stderr, result } = runCli({ publishedRed: true, priorityPrs: [FIX], stranded: true });
    expect(mainPushes, stderr).toEqual([]);
    expect(result.strandedSweep).toMatchObject({ skipped: 'red-main-hold', applied: [] });
  }, 30000);

  // Rollback/switch: with the setting OFF the only guard used to be the pre-pass stop, so a freeze raised after it
  // (mid-pass, or the setting switched OFF mid-watch) reached nothing and every PR landed on a frozen main.
  it('setting OFF + a freeze raised mid-pass (after the pre-pass stop check): nothing lands and nothing is pushed to main', () => {
    const { attempts, mainPushes, stderr, status } = runCli({ lateFreeze: true, priorityPrs: [FIX], holdSetting: 'off', stranded: true });
    expect(status, stderr).not.toBe(5); // the pre-pass stop did not see it — the in-pass hold is what catches it
    expect(attempts, stderr).toEqual([]);
    expect(mainPushes).toEqual([]);
  }, 30000);

  it('control: setting ON + a freeze raised mid-pass is held the same way (only the fix PR lands)', () => {
    const { attempts, mainPushes } = runCli({ lateFreeze: true, priorityPrs: [FIX], stranded: true });
    expect(attempts).toEqual([FIX]);
    expect(mainPushes).toEqual([]);
  }, 30000);

  it('setting OFF + manual freeze: the old stop (exit 5) still writes nothing to main', () => {
    const { mainPushes, status } = runCli({ freeze: 'env', holdSetting: 'off', stranded: true });
    expect(status).toBe(5);
    expect(mainPushes).toEqual([]);
  }, 30000);

  it('rollout + setting OFF: the migrated legacy freeze still stops the whole line (exit 5)', () => {
    const { attempts, status } = runCli({ freeze: 'legacy', holdSetting: 'off' });
    expect(status).toBe(5);
    expect(attempts).toEqual([]);
  }, 30000);
});

describe('runStrandedSweepStep — held while main is red (redMainHeld)', () => {
  const preview = { ok: true, ran: true, autoResolvable: [{ id: '7001', status: 'open', via: 'x' }], applied: [], mainLogUnavailable: false };
  const spies = () => {
    const calls = { sweep: [], lock: 0, push: 0, log: [] };
    return { calls, opts: {
      sweepFn: (o) => { calls.sweep.push(o); return preview; },
      lockFn: (fn) => { calls.lock++; return { ran: true, result: fn() }; },
      syncFn: () => ({ ok: true, head: 'h' }),
      pushFn: () => { calls.push++; return { pushed: true }; },
      log: (m) => calls.log.push(m),
    } };
  };
  it('held: previews only — no lock, no apply, no push — and reports skipped red-main-hold', async () => {
    const { runStrandedSweepStep } = await import('../merge-ai-prs.mjs');
    const { calls, opts } = spies();
    const r = runStrandedSweepStep({ ...opts, redMainHeld: true });
    expect(calls.sweep).toEqual([{ apply: false }]);
    expect(calls.lock + calls.push).toBe(0);
    expect(r).toMatchObject({ ok: true, ran: false, skipped: 'red-main-hold', applied: [], autoResolvable: [{ id: '7001' }] });
    expect(calls.log.join('')).toMatch(/stranded-sweep: main is red \(red-main-hold\) — not resolving #7001/);
  });
  it('held + dry-run: the preview says it is held, not "would resolve"', async () => {
    const { runStrandedSweepStep } = await import('../merge-ai-prs.mjs');
    const { calls, opts } = spies();
    runStrandedSweepStep({ ...opts, redMainHeld: true, dryRun: true });
    expect(calls.log.join('')).toMatch(/stranded-sweep DRY-RUN: main is red/);
    expect(calls.log.join('')).not.toMatch(/would resolve/);
  });
  it('not held: applies under the lock and pushes (unchanged)', async () => {
    const { runStrandedSweepStep } = await import('../merge-ai-prs.mjs');
    const { calls, opts } = spies();
    runStrandedSweepStep({ ...opts, sweepFn: (o) => { calls.sweep.push(o); return o.apply ? { ...preview, applied: [{ id: '7001', flipped: true }] } : preview; } });
    expect(calls.lock).toBe(1);
    expect(calls.push).toBe(1);
  });
});
