/**
 * @file breaks/lane-acquire-clean-lane-cheap.mjs — PR #6647 judge sweep (R903): `daemon-soak` went red on shards
 * 1, 4, 6, 8 ("the first daemon tick times out at 90s, 0 ticks checked") in every scenario whose rebuild smoke runs a
 * real `lane-pool.mjs acquire` (pinned-overlay-conflict-skipped, bad-overlay-falls-back, smoke-expired-gh-token,
 * smoke-github-outage, shallow-clone-unrelated-histories), while main was green 8/8.
 *
 * MECHANISM. The unpushed-work guard added to `acquire` (all-branches / HEAD / stash preservation evidence) ran its
 * FULL canonical-origin proof — `realSalvageIo` transport-config reads, a bounded `ls-remote`, the object-only
 * verification fetch — twice per candidate lane (once before the ordinary fetch, once before the reset) even on a
 * pristine lane whose every tip is already on origin. Measured in a 4-lane sim world with main moved: 89 git
 * children / ~7.5s per acquire versus 36 / ~2s on main. The daemon's smoke acquires with a short budget, so on a
 * loaded CI shard the extra seconds blew the tick's 90s bound.
 *
 * THE FIX (`lane-pool.mjs#laneTipsOnTrackingRefs`): both guard hooks first run a network-free, bounded check — are
 * HEAD, every branch and every stash entry already contained in the lane's origin tracking refs (freshly written by
 * acquire's own `fetch --prune` by the time the reset guard runs)? When none is local-only there is nothing to prove
 * on the network, so the guard returns without `ls-remote`, a verification fetch or the salvage evidence reads. Any
 * local-only commit or stash still takes the full strict proof unchanged. The salvage pass itself runs only from
 * explicit `gc` / `salvage-unpushed`, never from acquire.
 *
 * SCENARIO: a clean pool, origin/main moved so every lane is behind, then one real `acquire` behind a counting `git`
 * PATH shim. GREEN: no `ls-remote` and at most `GIT_CALL_BUDGET` git children. RED (pre-fix): an `ls-remote` and ~2.5x
 * the git children.
 */
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { runSoak } from '../soak.mjs';

// Pre-fix acquire measured 89 children in a 4-lane pool; main measured 36. The ceiling sits well between the two.
const GIT_CALL_BUDGET = 70;
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

function perRound(w, round, ctx, api) {
  if (round !== 0) return;
  const scriptPath = join(w.simCloneRoot, 'scripts', 'lane-pool.mjs');
  // Move origin/main so every lane is behind (the smoke's acquire after a main move).
  const mover = join(w.root, 'soak-mover');
  const g = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g(['clone', '-q', w.repos.we.originPath, mover]);
  g(['-c', 'user.name=soak', '-c', 'user.email=soak@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'soak: main moves'], mover);
  g(['push', '-q', 'origin', 'HEAD:main'], mover);

  const shimDir = join(w.root, 'soak-count-git-bin');
  mkdirSync(shimDir, { recursive: true });
  const log = join(shimDir, 'calls.log');
  writeFileSync(log, '');
  const shim = join(shimDir, 'git');
  writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexec "${REAL_GIT}" "$@"\n`);
  chmodSync(shim, 0o755);
  const env = { ...w.env, LANE_POOL_NO_RECOVER: '1', PATH: `${shimDir}:${w.env.PATH}` };

  const started = Date.now();
  const r = spawnSync(process.execPath, [scriptPath, 'acquire', '--purpose=smoke', '--session=soak-cheap-acquire', '--json'], {
    cwd: w.simCloneRoot, env, encoding: 'utf8', timeout: 120_000,
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  const lsRemote = calls.filter((c) => /(^|\s)ls-remote(\s|$)/.test(c)).length;
  api.say(`r00 lane-acquire-clean-lane-cheap: acquire of a clean lane after main moved -> exit ${r.status} in ${Date.now() - started}ms, ${calls.length} git calls (budget ${GIT_CALL_BUDGET}), ${lsRemote} ls-remote`);
  if (r.status !== 0) api.violation('bounded', `cheap-acquire: acquire of a clean lane failed (exit ${r.status}): ${(r.stderr || '').split('\n').filter((l) => l.startsWith('✗ ')).pop() ?? '(no reason)'}`);
  if (lsRemote > 0) api.violation('bounded', `cheap-acquire: a clean lane's acquire ran ${lsRemote} canonical-origin ls-remote proof(s) although no tip was local-only`);
  if (calls.length > GIT_CALL_BUDGET) api.violation('bounded', `cheap-acquire: a clean lane's acquire spawned ${calls.length} git children (budget ${GIT_CALL_BUDGET}) — daemon ticks time out at 90s on a loaded shard`);
}

export default {
  id: 'lane-acquire-clean-lane-cheap',
  title: 'acquire of a clean lane runs the full canonical-origin unpushed-work proof twice (89 git calls, ~3x main) and times daemon-soak ticks out at 90s',
  card: 'PR #6647 judge sweep R903 (daemon-soak shards 1,4,6,8 red; epic #4075)',
  fixedBy: { sha: '(PR #6647 fix-6647)', where: 'lane-pool.mjs laneTipsOnTrackingRefs / assertReadableLaneEvidence / assertNoUnpushedLaneWork', paths: ['scripts/lane-pool.mjs'] },
  fixPresent(root) {
    try { return readFileSync(join(root, 'scripts/lane-pool.mjs'), 'utf8').includes('laneTipsOnTrackingRefs'); } catch { return false; }
  },
  run({ log } = {}) {
    return runSoak({
      name: 'break:lane-acquire-clean-lane-cheap',
      rounds: 1,
      daemons: ['fix-dispatch'],
      mainEvery: 0,
      fleet: false,
      lanes: 4,
      bounds: { tickBoundMs: 110_000 },
      perRound,
      log,
    });
  },
  judge(report) {
    return report.violations
      .filter((v) => v.invariant === 'bounded' && /^cheap-acquire:/.test(v.detail))
      .map((v) => `${v.daemon ?? '-'} tick ${v.tick ?? '-'}: [${v.invariant}] ${v.detail}`);
  },
};
