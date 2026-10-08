/**
 * @file breaks/lease-reaper-prepare-pr-reaps-fresh-build.mjs — LIVE INCIDENT, 2026-10-08 (card `xp4r23a`).
 * lane-12 was acquired by build session `conveyor-4420` at 05:27:22Z and reaped by the resident lease-reaper as
 * `pr-merged` at 05:27:24Z — two seconds later, while the build was still running in it. Item 4420 was reaped
 * seven times that day the same way, on five different lanes.
 *
 * ROOT CAUSE: a `conveyor-<N>` lease's PR state is looked up by ITEM number (`byItem`, keyed by a PR's head ref
 * `lane/<N>-*`). That keyspace is shared by every stage of an item — its PREPARE PR (`lane/<N>-prepare-*`) and
 * every build attempt's PR. Item 4420's prepare PR #4358 had merged at 00:03:48Z, so every later build lease
 * for 4420 read `merged` and was reaped on the reaper's next tick. The lookup never compared WHEN the PR merged
 * with WHEN the lease was acquired.
 *
 * FIX (`xp4r23a`): `prTerminalPredatesLease` — a PR that merged/closed before the lease's own `acquiredAt` can't
 * be that lease's work, so the PR-terminal axis stays dormant for it (session-gone and TTL still apply).
 *
 * SCENARIO (resident reaper, `daemons: []`, same shape as `unrecognized-session-lease-outlives-merged-pr.mjs`):
 *   - lane-1 (the incident): session `conveyor-9201`, lease acquired 1 minute ago; the item's only PR is
 *     `lane/9201-prepare-x`, merged 6 hours ago. Pre-fix: reaped `pr-merged`. Post-fix: kept.
 *   - lane-2 (control): session `conveyor-9202`, lease acquired 30 minutes ago; PR `lane/9202-build` merged
 *     5 minutes ago — the lease's own work landed, so it must still reap `pr-merged` on both trees.
 */
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runSoak } from '../soak.mjs';

const MIN = 60_000;
const ago = (m) => new Date(Date.now() - m * MIN).toISOString();

function makeLane(poolDir, name, lease) {
  const dir = join(poolDir, name);
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: dir });
  writeFileSync(join(dir, '.git', '.lane-lease'), `${JSON.stringify(lease, null, 2)}\n`);
  return dir;
}

function fakeBin(root, prs) {
  const bin = join(root, 'fakebin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(prs)}\nJSON\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 1\n'); // session axis OFF — deterministic
  chmodSync(join(bin, 'claude'), 0o755);
  return bin;
}

export default {
  id: 'lease-reaper-prepare-pr-reaps-fresh-build',
  title: "the resident lease-reaper reaps a FRESH conveyor-<N> build lease as pr-merged seconds after acquire, off item N's earlier-merged prepare PR",
  card: 'we:backlog/xp4r23a-lease-reaper-reaps-a-fresh-build-lane-as-pr-merged-off-the-i.md',
  fixedBy: { sha: 'a3c11833cf101d86c4db067436385b678ebb52e5', where: 'lane/xp4r23a-reaper-fresh-lane', paths: ['scripts/conveyor/lease-reaper.mjs'] },
  fixPresent(root) {
    try {
      return /export function prTerminalPredatesLease/.test(readFileSync(join(root, 'scripts/conveyor/lease-reaper.mjs'), 'utf8'));
    } catch {
      return false;
    }
  },
  run({ log } = {}) {
    return runSoak({
      name: 'break:lease-reaper-prepare-pr-reaps-fresh-build',
      rounds: 1,
      daemons: [],
      mainEvery: 0,
      fleet: false,
      scorecards: false,
      junkInCwd: false,
      log,
      setup() {
        const base = mkdtempSync(join(tmpdir(), 'we-soak-fresh-build-'));
        const poolRoot = join(base, 'pool');
        const poolDir = join(poolRoot, 'web-everything');
        mkdirSync(poolDir, { recursive: true });
        makeLane(poolDir, 'lane-1', { session: 'conveyor-9201', purpose: 'build', acquiredAt: ago(1), ttlMinutes: 240 });
        makeLane(poolDir, 'lane-2', { session: 'conveyor-9202', purpose: 'build', acquiredAt: ago(30), ttlMinutes: 240 });
        const binDir = fakeBin(base, [
          { number: 9301, state: 'closed', head: { ref: 'lane/9201-prepare-x' }, merged_at: ago(360), closed_at: ago(360), merge_commit_sha: 'a'.repeat(40) },
          { number: 9302, state: 'closed', head: { ref: 'lane/9202-build' }, merged_at: ago(5), closed_at: ago(5), merge_commit_sha: 'b'.repeat(40) },
        ]);
        return { base, poolRoot, binDir, checked: false };
      },
      perRound(w, round, ctx, api) {
        try {
          const script = join(w.simCloneRoot, 'scripts/conveyor/lease-reaper.mjs');
          const env = { ...process.env, ...w.env, LANE_POOL_ROOT: ctx.poolRoot, PATH: `${ctx.binDir}:${process.env.PATH}` };
          const r = spawnSync('node', [script, '--dry-run', '--json'], { encoding: 'utf8', env, timeout: 20_000 });
          ctx.checked = true;
          let report = null;
          try { report = JSON.parse(r.stdout); } catch { /* reported below */ }
          if (!report) {
            api.violation('scenario-ran', `lease-reaper --dry-run --json produced no parseable output (exit ${r.status}); stderr: ${String(r.stderr || '').split('\n').slice(0, 3).join(' | ')}`);
            return;
          }
          ctx.report = report;
          api.say(`r00 lease-reaper --dry-run: wouldReap=${JSON.stringify(report.wouldReap)} kept=${report.kept} prAxis=${JSON.stringify(report.prAxis)}`);
          if (report.prAxis?.we !== 'on') {
            api.violation('scenario-ran', `PR-terminal axis for 'we' was OFF (${JSON.stringify(report.prAxis)}) — the fake gh was never consulted`);
            return;
          }
          const reaped = new Map((report.wouldReap || []).map((c) => [c.session, c.reason]));
          if (reaped.has('conveyor-9201')) {
            api.violation('fresh-build-reaped', `lane-1 (conveyor-9201, acquired 1m ago) was reaped ${reaped.get('conveyor-9201')} off its item's prepare PR that merged 6h BEFORE the lease existed`);
          }
          if (reaped.get('conveyor-9202') !== 'pr-merged') {
            api.violation('own-merge-not-reaped', `lane-2 (conveyor-9202, its own PR merged 5m ago, after the acquire) was not reaped pr-merged (got ${reaped.get('conveyor-9202') ?? 'kept'})`);
          }
        } finally {
          rmSync(ctx.base, { recursive: true, force: true });
        }
      },
    });
  },
  judge(report) {
    const OWN = new Set(['fresh-build-reaped', 'own-merge-not-reaped', 'scenario-ran']);
    const problems = report.violations.filter((v) => OWN.has(v.invariant)).map((v) => `[${v.invariant}] ${v.detail}`);
    if (!report.ctx?.checked) problems.push('[scenario-ran] the resident lease-reaper dry-run pass never ran');
    return problems;
  },
};
