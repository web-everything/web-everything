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
if (a[0] === 'remote' && a[1] === 'get-url') process.stdout.write('git@github.com:fixture/drain-rmh.git\\n');
if (a[0] === 'diff') process.exit(1);
process.exit(0);
`;

const FIX = 3001; // the published main-fix PR
const OTHER = 3002; // an unrelated PR that is otherwise fully mergeable

/**
 * @param {{ freeze?: 'env'|'legacy'|'both'|null, priorityPrs?: number[]|null, publishedRed?: boolean, holdSetting?: 'on'|'off'|null,
 *           fixMergeable?: string, unfreezeFirst?: boolean, dryRun?: boolean }} o
 */
function runCli({ freeze = null, priorityPrs = null, publishedRed = false, holdSetting = null, fixMergeable = 'MERGEABLE', unfreezeFirst = false, dryRun = false } = {}) {
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
      ...(freeze === 'sibling' ? {} : { WE_RED_MAIN_FREEZE_LEGACY: legacyMarker }), WE_MERGE_QUEUE_SETTINGS_FILE: mqSettings };
    if (freeze === 'sibling') delete env.WE_RED_MAIN_FREEZE_LEGACY;
    for (const k of ['VITEST', 'WE_UNDER_TEST', 'WE_MERGE_BREAK_GLASS', 'WE_RED_MAIN_FREEZE', 'WE_DRAIN_RED_MAIN_HOLD', 'WE_DRAIN_RED_MAIN_MODE']) delete env[k];
    if (freeze === 'env') env.WE_RED_MAIN_FREEZE = envMarker;
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
    return { status: r.status, result, stderr: r.stderr, attempts, newMarkerExists: existsSync(newMarker),
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

  it('rollout + setting OFF: the migrated legacy freeze still stops the whole line (exit 5)', () => {
    const { attempts, status } = runCli({ freeze: 'legacy', holdSetting: 'off' });
    expect(status).toBe(5);
    expect(attempts).toEqual([]);
  }, 30000);
});
