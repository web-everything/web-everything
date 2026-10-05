/**
 * Live incident, 2026-10-05 ET: review-daemon overlays A (#3964) and B (#3967)
 * branched from the same commit and edited the same lines. B conflicted with
 * main+A and was overlay-conflict-dropped on every rebuild for hours.
 *
 * Replay with a reviewed origin/edge/<B> merge containing both overlay heads.
 * RED: B is dropped and absent from the clone's ancestry. GREEN: ordinary daemon
 * ticks rebuild with B and record overlay-conflict-resolved via edge-ref.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runSoak } from '../soak.mjs';

const A = 'lane/overlay-conflict-edge-a';
const B = 'lane/overlay-conflict-edge-b';
const CONFLICT_PATH = 'soak/overlay-conflict-edge.md';
const RESOLVED = 'reviewed resolution of A and B\n';
const REGISTER_ROUND = 2;
const FINAL_ROUND = 9;

export default {
  id: 'overlay-conflict-edge-resolved',
  title: 'a conflicting overlay survives an ordinary rebuild using its reviewed edge ref',
  card: 'review-daemon incident 2026-10-05 ET (overlays #3964 and #3967)',
  fixedBy: {
    sha: '2c0975aa4',
    where: 'main',
    paths: ['scripts/lib/daemon-rebuild.mjs'],
  },
  fixPresent(root) {
    try {
      return /export function resolveOverlayConflict/.test(readFileSync(join(root, 'scripts/lib/daemon-rebuild.mjs'), 'utf8'));
    } catch { return false; }
  },
  async run({ log } = {}) {
    return runSoak({
      name: 'break:overlay-conflict-edge-resolved',
      rounds: FINAL_ROUND + 1,
      mainEvery: 0,
      scorecards: false,
      log,
      setup(w) {
        if (!existsSync(join(w.simCloneRoot, 'scripts/lib/daemon-rebuild.mjs'))) {
          throw new Error('overlay-conflict-edge-resolved: requires scripts/lib/daemon-rebuild.mjs');
        }
        // Set before daemon hosts boot, keeping the operator's overlay store isolated.
        w.env.WE_DAEMON_OVERLAY_DIR = join(w.root, 'daemon-overlays');
        return {};
      },
      async perRound(w, round, ctx, api) {
        if (round === REGISTER_ROUND) {
          const overlays = await import(pathToFileURL(join(w.simCloneRoot, 'scripts/lib/daemon-overlays.mjs')).href);
          api.moveMain(w, { [CONFLICT_PATH]: 'shared base\n' }, 'soak: shared overlay base');
          ctx.a = w.git.createBranch('we', A, { files: { [CONFLICT_PATH]: 'overlay A\n' } });
          ctx.b = w.git.createBranch('we', B, { files: { [CONFLICT_PATH]: 'overlay B\n' } });
          const edgeRef = `edge/${B}`;
          // Construct the reviewed merge in the fixture's bare remote. Its tree is
          // explicit, and both original PR heads remain parents (no helper under test).
          const resolved = w.git.createBranch('we', edgeRef, { from: B, files: { [CONFLICT_PATH]: RESOLVED } });
          const git = (args) => execFileSync('git', args, {
            cwd: w.repos.we.originPath, encoding: 'utf8', timeout: 30_000,
            env: { ...w.env, GIT_AUTHOR_NAME: 'Soak reviewer', GIT_AUTHOR_EMAIL: 'soak@example.test',
              GIT_COMMITTER_NAME: 'Soak reviewer', GIT_COMMITTER_EMAIL: 'soak@example.test' },
          }).trim();
          ctx.edge = git(['commit-tree', `${resolved}^{tree}`, '-p', ctx.a, '-p', ctx.b, '-m', 'soak: reviewed A+B conflict resolution']);
          git(['update-ref', `refs/heads/${edgeRef}`, ctx.edge]);
          const conflict = spawnSync('git', ['merge-tree', '--write-tree', '--no-messages', ctx.a, ctx.b], {
            cwd: w.repos.we.originPath, encoding: 'utf8', timeout: 30_000,
          });
          if (conflict.status !== 1) throw new Error(`fixture must conflict: ${conflict.status} ${conflict.stderr}`);
          overlays.addOverlay(w.simCloneRoot, { ref: A, pr: 3964 }, { env: w.env });
          overlays.addOverlay(w.simCloneRoot, { ref: B, pr: 3967 }, { env: w.env });
          ctx.main = api.moveMain(w, { 'soak/overlay-conflict-edge-trigger.md': 'rebuild main + A + B\n' }, 'soak: trigger edge resolution rebuild');
          api.say(`registered conflicting A/B overlays and reviewed ${edgeRef}; ordinary ticks must retain B`);
        }
        if (round === FINAL_ROUND) {
          const overlays = await import(pathToFileURL(join(w.simCloneRoot, 'scripts/lib/daemon-overlays.mjs')).href);
          const lastGood = await import(pathToFileURL(join(w.simCloneRoot, 'scripts/lib/daemon-last-good.mjs')).href);
          for (const [name, sha] of [['main', ctx.main], ['A', ctx.a], ['B', ctx.b]]) {
            const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], {
              cwd: w.simCloneRoot, encoding: 'utf8', timeout: 30_000,
            });
            if (ancestor.status !== 0) api.violation('missing-ancestor', `${name} (${sha}) is not an ancestor of clone HEAD: ${ancestor.stderr}`);
          }
          if (!overlays.readOverlayState(w.simCloneRoot, { env: w.env }).overlays.some((o) => o.ref === B)) {
            api.violation('overlay-dropped', 'B must remain registered after edge resolution');
          }
          if (readFileSync(join(w.simCloneRoot, CONFLICT_PATH), 'utf8') !== RESOLVED) {
            api.violation('wrong-resolution', 'clone does not carry the reviewed A+B resolution');
          }
          const alertsPath = join(lastGood.daemonStateDir(w.env), `${overlays.cloneKey(w.simCloneRoot)}.alerts.jsonl`);
          const alerts = existsSync(alertsPath) ? readFileSync(alertsPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
          if (!alerts.some((a) => a.kind === 'overlay-conflict-resolved' && a.detail?.ref === B
            && a.detail?.via === 'edge-ref' && a.detail?.edgeSha === ctx.edge)) {
            api.violation('missing-alert', 'no overlay-conflict-resolved alert for B via the reviewed edge-ref');
          }
          if (alerts.some((a) => a.kind === 'overlay-conflict-dropped' && a.detail?.ref === B)) {
            api.violation('overlay-dropped', 'B was reported overlay-conflict-dropped');
          }
        }
      },
    });
  },
  judge(report) {
    return report.violations.map((v) => `${v.daemon ?? '-'} tick ${v.tick ?? '-'}: [${v.invariant}] ${v.detail}`);
  },
};
