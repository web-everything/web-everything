/** Live 2026-11-05 (drain 17:06Z, merge daemon since 15:38Z): rebuild smokes that failed only because the host
 *  was overloaded (process-group timeout, "smoke budget exhausted" skips, gh-throttle + reconcile read failed)
 *  were recorded as a code rejection with retryAt null, so the daemon never adopted newer code.
 *  Fix: those rows are load-shaped when host-load evidence says overloaded → smoke-env-load with a retryAt. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runSoak } from '../soak.mjs';

const CLASSIFIER = 'scripts/lib/daemon-rebuild/smoke-classify/load-shaped.mjs';
const REF = 'lane/soak-sticky-load';
const OVERLAY_FILE = 'soak/sticky-load-overlay.txt';
const BUDGET = 'skipped: rebuild smoke budget exhausted (0ms left)';
const THROTTLE = 'gh-throttle: throttled — no gh slot within 8.095s (class=background); retry next tick';

const overloadedRows = () => [
  { name: 'dispatch-dry-run', ok: false, ms: 533869, mayBeTransient: false, detail: 'dispatch dry-run child failed: timed out after 533869ms (process group killed)' },
  // The real check wraps the refusal: `checkTreeStaysClean` emits `git status --porcelain failed: <refusal>`.
  { name: 'tree-stays-clean', ok: false, ms: 0, mayBeTransient: false, detail: `git status --porcelain failed: ${BUDGET}` },
  { name: 'daemon-entries-boot', ok: false, ms: 3, mayBeTransient: false,
    entries: [{ ok: false, kind: `child failed: ${BUDGET}`, timeoutMs: 60000, elapsedMs: 0,
      attempts: [{ ok: false, kind: `child failed: ${BUDGET}` }] }],
    detail: `1/1 daemon entries failed to boot:\n- skills-src/conveyor/runner.mjs: child failed: ${BUDGET}` },
];
const throttleRows = () => [
  { name: 'dispatch-dry-run', ok: false, ms: 9000, mayBeTransient: false,
    detail: `dispatch dry-run failed (2/7): reconcile-ci-heal-pass: ${THROTTLE}\n; reconcile-review-pass: reconcile failed: reconcile read failed (exit 1): ${THROTTLE}` },
];

export default {
  id: 'sticky-load-shaped-rejection',
  title: 'smoke rows that fail only under host overload (timeout, budget-exhausted skips, throttle + reconcile read) retry with backoff instead of a sticky rejection',
  card: 'sticky-load-rejection (R630)',
  fixedBy: { sha: 'pending', where: 'lane/sticky-load-rejection', paths: [CLASSIFIER] },
  fixPresent(root) {
    try { return readFileSync(join(root, CLASSIFIER), 'utf8').includes('cachedRejectionLoadRetry'); } catch { return false; }
  },
  run({ log } = {}) {
    return runSoak({
      name: 'break:sticky-load-shaped-rejection',
      rounds: 1, daemons: [], fleet: false, mainEvery: 0, scorecards: false, log,
      setup(w) {
        Object.assign(w.env, {
          WE_DAEMON_CLONE_LOCK_ROOT: join(w.root, 'clone-lock'),
          WE_DAEMON_OVERLAY_DIR: join(w.root, 'daemon-overlays'),
          WE_DAEMON_REBUILD_SKIP_UNRELATED: '0',
          WE_DAEMON_SMOKE_LOAD_DIFFERENTIAL: '1',
          WE_REBUILD_SMOKE_REUSE_ENABLED: '0',
          WE_DAEMON_ENV_LOAD_RETRY_BASE_MS: '300000',
          WE_DAEMON_ENV_LOAD_RETRY_MAX_MS: '3600000',
          WE_SMOKE_HOST_LOAD1: '120',
          WE_SMOKE_HOST_CORES: '12',
        });
      },
      async perRound(w, round, ctx, api) {
        const load = relative => import(pathToFileURL(join(w.simCloneRoot, relative)).href);
        const { rebuildClone, readRebuildState } = await load('scripts/lib/daemon-rebuild.mjs');
        const { classifySmokeFailure } = await load('scripts/lib/daemon-live-smoke.mjs');
        w.git.createBranch('we', REF, { files: { [OVERLAY_FILE]: 'healthy overlay\n' } });
        const { addOverlay } = await load('scripts/lib/daemon-overlays.mjs');
        addOverlay(w.simCloneRoot, { ref: REF }, { env: w.env });
        api.moveMain(w, { 'soak/sticky-load-main.txt': 'main moved once\n' }, 'soak: main moves before the overloaded smoke');

        const { isLoadShapedRow } = await load(CLASSIFIER);
        const clock = Date.parse('2026-11-05T17:00:00Z');
        const rebuild = () => rebuildClone({
          root: w.simCloneRoot, env: w.env, now: () => clock, prState: async () => null,
          dispatchSmoke: { settings: { dispatchSmoke: 'off' }, run: async () => ({ ok: true }), match: () => [] },
          runSmoke: async () => {
            const results = overloadedRows();
            return { verdict: classifySmokeFailure(results), attempts: 1, smoke: { pass: false, disabled: false, results } };
          },
        });
        const result = await rebuild();
        const state = readRebuildState(w.simCloneRoot, w.env);
        const retryAt = Date.parse(state.rejected?.retryAt || '');
        if (result.reason !== 'smoke-env-load' || !state.rejected?.envLoad || !Number.isFinite(retryAt) || retryAt <= clock) {
          api.violation('sticky-rejection', `reason=${result.reason}, rejected=${JSON.stringify(state.rejected)}`);
        }
        if (existsSync(join(w.simCloneRoot, OVERLAY_FILE))) api.violation('unverified-adoption', 'overload verdict adopted the overlay');
        // The throttle + downstream reconcile-read shape is load-shaped under overload.
        if (!throttleRows().every(row => isLoadShapedRow(row, w.env))) {
          api.violation('throttle-reconcile-sticky', 'gh-throttle + reconcile read failed row not load-shaped under overload');
        }
        // No laundering: the same rows on an idle host stay code-shaped.
        const idleEnv = { ...w.env, WE_SMOKE_HOST_LOAD1: '1' };
        const laundered = [...overloadedRows(), ...throttleRows()].filter(row => row.name !== 'dispatch-dry-run' && isLoadShapedRow(row, idleEnv));
        if (laundered.length || throttleRows().some(row => isLoadShapedRow(row, idleEnv))) {
          api.violation('idle-host-laundered', `idle host: ${laundered.map(r => r.name).join(',') || 'throttle+reconcile row'} classified load-shaped`);
        }
        api.say(`overloaded=${result.reason}`);
      },
    });
  },
  judge: report => report.violations.map(row => `[${row.invariant}] ${row.detail}`),
};
