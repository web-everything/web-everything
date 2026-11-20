/** An established overlay conflicting with advancing main used to hold the clone forever. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRebuild, readOverlayEventLog } from '../../../lib/daemon-rebuild/prepare.mjs';
import { readRebuildState, writeRebuildState } from '../../../lib/daemon-rebuild/state.mjs';
import { addOverlay, readOverlays } from '../../../lib/daemon-overlays.mjs';
import { REBUILD_IDENTITY_ENV } from '../../../lib/daemon-rebuild/shared.mjs';
import { smokeAndAdopt } from '../../../lib/daemon-rebuild/smoke.mjs';
import { decideLastGood } from '../../../lib/daemon-last-good.mjs';
import { assertMainNotStale } from '../../../lib/main-staleness.mjs';

export default {
  id: 'established-overlay-conflict-park',
  title: 'an established overlay conflict holds only until the park deadline and retains registration',
  card: 'main-fix: bounded established overlay hold',
  fixedBy: { sha: 'same-pr', where: 'same-pr', paths: ['scripts/lib/daemon-rebuild/prepare.mjs', 'scripts/lib/daemon-rebuild/plan.mjs'] },
  // This break ships with the fix: reverting the fix must fail, never become an expected failure.
  fixPresent() { return true; },
  async run() {
    const dir = mkdtempSync(join(tmpdir(), 'soak-established-park-'));
    const root = join(dir, 'clone');
    const ref = 'lane/live';
    const start = Date.parse('2026-11-18T10:00:00Z');
    const parkMinutes = 2;
    const env = {
      PATH: process.env.PATH, HOME: dir, TMPDIR: dir, GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(dir, 'no-gitconfig'), ...REBUILD_IDENTITY_ENV,
      WE_DAEMON_STATE_DIR: join(dir, 'state'), WE_DAEMON_OVERLAY_DIR: join(dir, 'overlays'),
      WE_DAEMON_EVENTS: join(dir, 'events.jsonl'), WE_PLATFORM_PREFERENCES_FILE: join(dir, 'prefs.json'),
      WE_DAEMON_AUTO_REBASE: '0', WE_DAEMON_REBUILD_SKIP_UNRELATED: '0',
      WE_DAEMON_OVERLAY_EDGE_RESOLVE: '0', WE_DAEMON_ESTABLISHED_OVERLAY_PARK_MINUTES: String(parkMinutes),
    };
    const git = (...args) => {
      const r = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
      if (r.status !== 0) throw new Error(`fixture git ${args[0]} failed: ${r.stderr}`);
      return r.stdout.trim();
    };
    try {
      writeFileSync(env.WE_PLATFORM_PREFERENCES_FILE, '{}');
      git('init', '-q', '-b', 'main', root);
      const commit = (text, parent) => {
        writeFileSync(join(root, 'live.txt'), text);
        git('-C', root, 'add', 'live.txt');
        const tree = git('-C', root, 'write-tree');
        return git('-C', root, 'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', text);
      };
      const base = commit('base\n');
      const sha = commit('overlay\n', base);
      const main = commit('main\n', base);
      git('-C', root, 'update-ref', 'refs/heads/main', sha);
      git('-C', root, 'reset', '--hard', sha);
      git('-C', root, 'update-ref', `refs/remotes/origin/${ref}`, sha);
      git('-C', root, 'update-ref', 'refs/remotes/origin/main', main);
      addOverlay(root, { ref }, { env });
      writeRebuildState(root, { adopted: { head: sha, applied: [{ ref, sha }] } }, env);
      // Tracking refs above model the fetch result; all planning and conflict detection use real local Git.
      const run = (args, opts) => args[0] === 'fetch'
        ? { status: 0, stdout: '', stderr: '' }
        : spawnSync('git', args, { ...opts, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
      const tick = (time) => prepareRebuild({ root, env, run, now: () => time, prBaseChain: () => [] });
      const violations = [];
      const check = (ok, message) => { if (!ok) violations.push(message); };
      for (const time of [start, start + parkMinutes * 60_000]) {
        const r = await tick(time);
        const held = readRebuildState(root, env).held;
        check(r.terminal && r.result.reason === 'established-overlay-conflict', 'conflict must hold through the deadline');
        check(held?.reason === 'established-overlay-conflict' && held.since === new Date(start).toISOString(), 'hold clock must persist');
        check(r.alerts.some(a => a.kind === 'established-overlay-hold'), 'hold must alert');
      }
      const r = await tick(start + parkMinutes * 60_000 + 1);
      check(r.terminal === false && git('-C', root, 'rev-parse', `${r.plan.finalSha}^{tree}`)
        === git('-C', root, 'rev-parse', `${main}^{tree}`), 'expired hold must proceed to build advancing main');
      check(git('-C', root, 'log', '-1', '--format=%P%x09%s', r.plan.finalSha)
        === `${main} ${sha}\tdaemon-rebuild: merge overlay ${ref} onto ${main} (identity marker)`,
      'parked build must preserve the adopted identity without applying its content');
      check(readRebuildState(root, env).held === null, 'expired hold must clear');
      check(readOverlays(root, { env }).some(o => o.ref === ref), 'parked overlay must remain registered');
      check(r.alerts.some(a => a.kind === 'established-overlay-parked' && a.detail.ref === ref && a.detail.sha === sha), 'park must alert with the lost overlay tip');
      check(!r.alerts.some(a => a.kind === 'established-overlay-hold'), 'park must stop holding');
      check(readOverlayEventLog(root, env).some(e => e.kind === 'established-overlay-parked' && e.ref === ref), 'park must leave audit evidence');

      // Same live case, next tick: candidate code fails while the last-good control passes.
      // Retained park authorization must not erase the smoke hold or re-emit the park notice.
      let smokeCalls = 0;
      const rejected = await smokeAndAdopt({ root, env, stEnv: env, log: {}, run,
        runSmoke: async () => {
          const ok = ++smokeCalls > 1;
          return { verdict: ok ? 'pass' : 'code', attempts: 1,
            smoke: { results: [{ name: 'boot', ok, mayBeTransient: false, detail: 'deterministic candidate failure', ms: 1 }] } };
        },
        now: () => start + parkMinutes * 60_000 + 2,
        plan: r.plan, prevHead: sha, lease: r.lease, overlaysBefore: [], prepAlerts: r.alerts,
        finalLockOpts: { env, lockRoot: join(dir, 'locks') },
        dispatchSmoke: { settings: { dispatchSmoke: 'off' }, run: async () => ({}), match: () => false },
      });
      check(rejected.reason === 'smoke-rejected' && smokeCalls === 2, 'candidate failure and passing last-good control must reject');
      const smokeHold = readRebuildState(root, env).held;
      check(smokeHold?.reason === 'smoke-rejected' && smokeHold.controlPassed, 'smoke must record its hold');
      const notices = JSON.stringify(readRebuildState(root, env).pinnedNotified);
      const parkEvents = readOverlayEventLog(root, env).filter(e => e.kind === 'established-overlay-parked').length;
      const later = start + 3 * 3_600_000;
      const again = await tick(later);
      const state = readRebuildState(root, env);
      check(again.result?.reason === 'still-rejected', 'unchanged inputs must remain rejected');
      check(JSON.stringify(state.held) === JSON.stringify(smokeHold), 'repeated parking must preserve the smoke hold unchanged');
      check(state.building === null && git('-C', root, 'rev-parse', 'HEAD') === sha, 'rejection must leave last-good HEAD without a build lease');
      check(JSON.stringify(state.pinnedNotified) === notices && !again.alerts.some(a => a.kind === 'established-overlay-parked')
        && readOverlayEventLog(root, env).filter(e => e.kind === 'established-overlay-parked').length === parkEvents,
      'repeated parking must not rewrite notices or emit another park event');
      const lastGood = () => decideLastGood({ headSha: sha, state, nowMs: later, maxAgeMs: 24 * 3_600_000, freshAdoptMs: 0 });
      const onLastGood = lastGood().onLastGood;
      let refusal = null;
      const managedBefore = process.env.WE_DAEMON_MANAGED_CLONE;
      process.env.WE_DAEMON_MANAGED_CLONE = '1';
      try {
        assertMainNotStale(root, () => ({ action: 'warn', behind: 1, dirty: false }), {
          listBehindFiles: () => ['scripts/conveyor/review-dispatch.mjs'],
          lastGood, rebuildGrace: () => ({ grace: false }), write: () => {},
        });
      } catch (error) { refusal = error.message; }
      finally {
        if (managedBefore === undefined) delete process.env.WE_DAEMON_MANAGED_CLONE;
        else process.env.WE_DAEMON_MANAGED_CLONE = managedBefore;
      }
      check(onLastGood && !refusal, `last-good dispatch must survive repeated parking: ${JSON.stringify({ held: state.held, onLastGood, refusal })}`);

      // PR #7104 round 4 — a mechanism-pinned live overlay A conflicts with main, and its registered clean repair B
      // (A + main) applies. The identity marker kept for A must not erase B's carrier proof: no hold, no needs-you.
      const repairRoot = join(dir, 'repair');
      const repairEnv = { ...env, WE_DAEMON_STATE_DIR: join(dir, 'repair-state'), WE_DAEMON_OVERLAY_DIR: join(dir, 'repair-overlays'),
        WE_DAEMON_EVENTS: join(dir, 'repair-events.jsonl'), WE_DAEMON_OVERLAY_FOLLOW_TIP: 'audited-only',
        WE_FIX_READY_PATH: join(dir, 'no-ready-records.jsonl') };
      git('init', '-q', '-b', 'main', repairRoot);
      const MECH = 'scripts/daemon-overlay.mjs';
      const files = { [MECH]: 'base\n', 'scripts/lib/daemon-rebuild.mjs': 'export {};\n', 'scripts/lib/daemon-overlays.mjs': 'export {};\n' };
      const snap = (mech, ...parents) => {
        for (const [p, text] of Object.entries({ ...files, [MECH]: mech })) {
          const blob = spawnSync('git', ['-C', repairRoot, 'hash-object', '-w', '--stdin'],
            { cwd: dir, env, input: text, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 }).stdout.trim();
          git('-C', repairRoot, 'update-index', '--add', '--cacheinfo', `100644,${blob},${p}`);
        }
        const tree = git('-C', repairRoot, 'write-tree');
        return git('-C', repairRoot, 'commit-tree', tree, ...parents.flatMap(p => ['-p', p]), '-m', mech.trim());
      };
      const rBase = snap('base\n');
      const a = snap('live mechanism fix\n', rBase);
      const rMain = snap('main rewrite\n', rBase);
      const b = snap('live mechanism fix + main rewrite\n', a, rMain);
      const repairRef = 'lane/live-rebased';
      git('-C', repairRoot, 'update-ref', 'refs/heads/main', a);
      git('-C', repairRoot, 'reset', '-q', '--hard', a);
      git('-C', repairRoot, 'update-ref', `refs/remotes/origin/${ref}`, a);
      git('-C', repairRoot, 'update-ref', `refs/remotes/origin/${repairRef}`, b);
      git('-C', repairRoot, 'update-ref', 'refs/remotes/origin/main', rMain);
      addOverlay(repairRoot, { ref }, { env: repairEnv });
      addOverlay(repairRoot, { ref: repairRef, reason: `auto-rebase of ${ref}` }, { env: repairEnv });
      writeRebuildState(repairRoot, { adopted: { head: a, applied: [{ ref, sha: a }] } }, repairEnv);
      const repaired = await prepareRebuild({ root: repairRoot, env: repairEnv, run, now: () => start, prBaseChain: () => [] });
      check(!(repaired.terminal && repaired.result?.reason === 'established-overlay-conflict'),
        'a clean registered repair carrying the lost mechanism tip must not hold');
      check(repaired.plan?.applied?.some(x => x.ref === repairRef && x.sha === b), 'the carrier repair must apply');
      check(!repaired.alerts.some(x => x.kind === 'established-overlay-needs-you'), 'a carried mechanism tip must not need you');
      check(readRebuildState(repairRoot, repairEnv).held == null, 'a carried mechanism tip must not persist a hold');
      return { violations };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  judge(report) { return report.violations; },
};
