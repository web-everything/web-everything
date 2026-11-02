/** PR #6260: shared gh-slot contention must back off a rebuild without blaming or adopting its overlay. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runSoak } from '../soak.mjs';

const CLASSIFIER = 'scripts/lib/daemon-rebuild/smoke-classify/load-shaped.mjs';
const REF = 'lane/soak-gh-throttle';
const OVERLAY_FILE = 'soak/gh-throttle-overlay.txt';
const REFUSAL = 'gh-throttle: throttled — no gh slot within 8.158s (class=background); retry next tick';

export default {
  id: 'smoke-gh-throttle-load-shaped',
  title: 'a shared gh-slot refusal holds the rebuild with backoff, keeps its overlay, and recovers without a main move',
  card: 'PR #6260',
  fixedBy: {
    sha: '228347a9bca7db6805012f4616e089058a3a809b',
    where: 'lane/smoke-gh-throttle-load-shaped',
    paths: [CLASSIFIER],
  },
  fixPresent(root) {
    try { return readFileSync(join(root, CLASSIFIER), 'utf8').includes('if (isGhThrottleOnlyDetail(detail)) return true;'); }
    catch { return false; }
  },
  run({ log } = {}) {
    return runSoak({
      name: 'break:smoke-gh-throttle-load-shaped',
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
        });
      },
      async perRound(w, round, ctx, api) {
        const load = relative => import(pathToFileURL(join(w.simCloneRoot, relative)).href);
        const { rebuildClone, readRebuildState, readyCandidatePath } = await load('scripts/lib/daemon-rebuild.mjs');
        const { addOverlay, readOverlays } = await load('scripts/lib/daemon-overlays.mjs');
        const { runLiveSmoke, classifySmokeFailure } = await load('scripts/lib/daemon-live-smoke.mjs');
        const { isLoadShapedRow } = await load(CLASSIFIER);
        const git = args => execFileSync('git', args, {
          cwd: w.simCloneRoot, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024,
        }).trim();
        const prevHead = git(['rev-parse', 'HEAD']);
        w.git.createBranch('we', REF, { files: { [OVERLAY_FILE]: 'healthy overlay\n' } });
        addOverlay(w.simCloneRoot, { ref: REF }, { env: w.env });
        api.moveMain(w, { 'soak/gh-throttle-main.txt': 'main moved once\n' }, 'soak: main moves before gh contention');

        let clock = Date.parse('2026-11-02T12:00:00Z');
        let contended = true;
        let smokeCalls = 0;
        // Exercise the live-smoke producer, including the non-transient flag and timings suffix, rather
        // than supplying a hand-written smoke row. All external child IO is hermetic.
        const smoke = async (options, mixed = false) => runLiveSmoke({
          ...options, repos: [], shadow: () => null, admit: () => null, load: () => 0, cores: () => 1,
          runChild: async (cmd, args, opts) => {
            if (opts.env.GH_CALLER === 'rebuild-smoke:dispatch-dry-run') return JSON.stringify([
              { kind: 'review', ok: !mixed, ms: 12, ...(mixed ? { error: 'TypeError: x is not a function' } : {}) },
              { kind: 'reconcile-fix-pass', ok: !contended, ms: 8200, ...(contended ? { error: REFUSAL } : {}) },
            ]);
            if (args[1] === 'list') return '[]';
            if (args[1] === 'acquire') return JSON.stringify({ lane: 2 });
            return cmd === 'node' ? JSON.stringify({ ok: true }) : '';
          },
        });
        const mixed = await smoke({ root: w.simCloneRoot, env: w.env }, true);
        const mixedRow = mixed.results.find(row => row.name === 'dispatch-dry-run');
        if (!mixedRow || mixedRow.ok || isLoadShapedRow(mixedRow, w.env)
          || classifySmokeFailure(mixed.results) !== 'code') {
          api.violation('mixed-code-laundered', 'a real dispatch code failure alongside the refusal must stay code-shaped');
        }
        const rebuild = () => rebuildClone({
          root: w.simCloneRoot, env: w.env, now: () => clock, prState: async () => null,
          dispatchSmoke: { settings: { dispatchSmoke: 'off' }, run: async () => ({ ok: true }), match: () => [] },
          runSmoke: async options => {
            smokeCalls++;
            const result = await smoke(options);
            const failed = result.results.filter(row => !row.ok);
            if (contended && (failed.length !== 1 || failed[0].name !== 'dispatch-dry-run'
              || failed[0].mayBeTransient !== false || !failed[0].detail.endsWith('review 12ms, reconcile-fix-pass 8.2s'))) {
              api.violation('wrong-smoke-fixture', 'expected only the production dispatch refusal with its timings suffix');
            }
            return { verdict: classifySmokeFailure(result.results), attempts: 1, smoke: result };
          },
        });

        // Two attempts on identical inputs prove exponential backoff rather than a sticky code rejection.
        for (const attempt of [1, 2]) {
          const result = await rebuild();
          const state = readRebuildState(w.simCloneRoot, w.env);
          const delay = 300000 * 2 ** (attempt - 1);
          if (result.reason !== 'smoke-env-load' || result.moved || result.adopted
            || state.held?.reason !== 'smoke-env-load' || !state.rejected?.envLoad
            || state.rejected.attempts !== attempt || Date.parse(state.rejected.retryAt) !== clock + delay) {
            api.violation('not-env-load-backoff', `attempt ${attempt}: reason=${result.reason}, rejected=${JSON.stringify(state.rejected)}`);
          }
          if (git(['rev-parse', 'HEAD']) !== prevHead || existsSync(join(w.simCloneRoot, OVERLAY_FILE))
            || existsSync(readyCandidatePath(w.simCloneRoot, w.env))) {
            api.violation('unverified-adoption', 'slot refusal moved last-good or recorded a ready candidate');
          }
          if (!readOverlays(w.simCloneRoot, { env: w.env }).some(row => row.ref === REF)) {
            api.violation('healthy-overlay-dropped', 'the shared refusal removed the overlay');
          }
          if (smokeCalls !== attempt * 2) {
            api.violation('wrong-comparison', `expected A + plain main per attempt, saw ${smokeCalls} smokes`);
          }
          clock += delay - 1;
          const before = smokeCalls;
          const waiting = await rebuild();
          if (waiting.reason !== 'still-rejected' || smokeCalls !== before) {
            api.violation('backoff-ignored', `reason=${waiting.reason}, smoke calls=${smokeCalls - before}`);
          }
          clock++;
        }

        // Nothing in Git changes: only contention clears and the due retry may now adopt the clean pass.
        contended = false;
        const recovered = await rebuild();
        const state = readRebuildState(w.simCloneRoot, w.env);
        if (!recovered.adopted || !recovered.moved || smokeCalls !== 5
          || !existsSync(join(w.simCloneRoot, OVERLAY_FILE)) || state.rejected || state.held
          || !readOverlays(w.simCloneRoot, { env: w.env }).some(row => row.ref === REF)) {
          api.violation('no-clean-recovery', `reason=${recovered.reason}, smoke calls=${smokeCalls}, rejected=${JSON.stringify(state.rejected)}`);
        }
        api.say(`gh contention: ${smokeCalls} smokes, recovery=${recovered.reason}`);
      },
    });
  },
  judge: report => report.violations.map(row => `[${row.invariant}] ${row.detail}`),
};
