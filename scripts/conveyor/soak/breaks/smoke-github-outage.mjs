/**
 * @file breaks/smoke-github-outage.mjs — live incident, 2026-10-12 13:10 ET.
 * GitHub 502/504s made the drain code-clone smoke reject a healthy build, blame overlays
 * #5020/#5009/#5037, and fall back to plain main.
 *
 * MECHANISM. reconcile-dry-run failed with "could not read state: Command failed: gh pr list …"
 * while dispatch-dry-run timed out. These tree-code rows could classify as code failure even
 * when the external service was down, entering the reject/control/fallback ladder.
 *
 * THE FIX (1777c2e96): GitHub-read-shaped failures invite the gate-owned
 * probeGithubApiAvailability. Its own 5xx/timeout/rate-limit evidence confirms unavailability;
 * bounded retries with backoff end in env-unavailable. The rebuild holds as
 * smoke-env-unavailable with NO reject record, overlay suspects, or fallback-plain-main.
 *
 * SCENARIO (review daemon only, no fleet): setup pins cheap retries before the host forks;
 * the sim world already bounds children and selects inline rebuilds. r0 settles. r1 arms
 * 1000 fake `pr list` HTTP 502 responses and moves main by touching reconcile-pass.mjs,
 * forcing reconcile-dry-run past skip-unchanged. r2 reads rebuild state, alerts, and ancestry
 * after r1's inline rebuild finishes. Adoption is not expected during the persistent outage.
 *
 * RED (pre-fix): the failed tree-code read rejects healthy code, then the last-good control
 * can fail identically and hold as smoke-harness-broken (or adopt via the not-worse path).
 * Observed with the fix reversed: smoke-rejected + smoke-harness-broken-adopted-not-worse;
 * the reject alert still fails the judge even though adoption clears state.rejected.
 * Any overlay blame/fallback is also a violation. GREEN: the gate independently confirms the outage and holds the current build
 * as smoke-env-unavailable, without rejection, harness blame, or fallback.
 */

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { runSoak } from '../soak.mjs';

const MOVE_ROUND = 1;
const JUDGE_ROUND = 2;
const SPECIFIC = new Set([
  'reject-record-written', 'overlay-blamed-or-fallback', 'held-as-harness-broken',
  'not-held-as-env-unavailable', 'rebuild-state-unreadable',
  'budget-exhausted-outage-rejected',
]);

// Post-accept red team, 2026-10-13: the confirmed outage retry consumed all three reconcile caps,
// then dispatch/boot/status were refused. Use the production budget wrapper and a virtual clock so
// this recovery-path scenario costs milliseconds rather than six minutes and never needs a fleet.
export async function replayBudgetExhaustedOutage(root) {
  const { runLiveSmokeWithRetry } = await import(pathToFileURL(join(root, 'scripts/lib/daemon-live-smoke.mjs')).href);
  const { budgetedRunChild } = await import(pathToFileURL(join(root, 'scripts/lib/daemon-rebuild/smoke.mjs')).href);
  let t = 0;
  let attempt = 0;
  const runChild = budgetedRunChild({ deadline: 360010, now: () => t,
    runChild: async (cmd, args, opts) => {
      if (cmd === 'gh' && args.includes('number,headRefOid,labels,statusCheckRollup,mergeStateStatus,comments,body,files')) {
        throw new Error('HTTP 502: Bad Gateway');
      }
      if (cmd === 'node' && args[1] === 'list') { attempt++; return '[]'; }
      if (args[1] === 'acquire') return '{"lane":1}';
      if (args[0] === 'scripts/conveyor/reconcile-pass.mjs') {
        if (attempt === 1) throw new Error('could not read state: Command failed: gh pr list');
        t += opts.timeoutMs;
        throw new Error(`timed out after ${opts.timeoutMs}ms (process group killed)`);
      }
      if (args[0] === '--input-type=module') return String(args[2]).includes('daemon-boot-smoke:entry-boot')
        ? '{"ok":true}' : '[{"kind":"stub","ok":true}]';
      return '';
    } });
  return runLiveSmokeWithRetry({ root, runChild, clock: () => t,
    env: { WE_SMOKE_LOAD_SCALE: '0', WE_SMOKE_BUSY_LOAD_RATIO: '1e9', WE_SMOKE_GH_ENV_PROBE: '1', WE_RESOURCE_SHADOW: 'off' },
    refreshAuth: async ({ env }) => ({ env, refresh: null }),
    retries: 1, backoffMs: 10, sleep: async (ms) => { t += ms; }, log: { error() {} } });
}

export default {
  id: 'smoke-github-outage',
  title: 'a GitHub API outage holds the rebuild as smoke-env-unavailable without rejecting healthy code or blaming overlays',
  card: 'live incident 2026-10-12 13:10 ET, epic #4075',
  fixedBy: {
    sha: '1777c2e96',
    where: 'lane/smoke-gh-env-failure',
    paths: [
      'scripts/lib/daemon-live-smoke.mjs',
      'scripts/lib/daemon-rebuild/smoke-classify/env-unavailable.mjs',
      'scripts/lib/daemon-rebuild/smoke-classify/index.mjs',
    ],
  },
  fixPresent(root) {
    try {
      return /export async function probeGithubApiAvailability/.test(readFileSync(join(root, 'scripts/lib/daemon-live-smoke.mjs'), 'utf8'));
    } catch { return false; }
  },
  async run({ log } = {}) {
    const report = await runSoak({
      name: 'break:smoke-github-outage',
      rounds: JUDGE_ROUND + 1,
      daemons: ['review'],
      mainEvery: 0,
      fleet: false,
      scorecards: false,
      log,
      setup(w) {
        // Set before the host forks. world.mjs already bounds children and pins inline rebuilds.
        Object.assign(w.env, {
          WE_DAEMON_SMOKE_RETRY_BACKOFF_MS: '10',
          WE_DAEMON_SMOKE_TRANSIENT_RETRIES: '1',
          WE_SMOKE_GH_ENV_PROBE: '1',
        });
        return {};
      },
      async perRound(w, round, ctx, api) {
        if (round === MOVE_ROUND) {
          w.gh.fault({ verb: 'pr list', kind: '5xx', times: 1000 });
          const rel = 'scripts/conveyor/reconcile-pass.mjs';
          const body = readFileSync(join(w.simCloneRoot, rel), 'utf8');
          ctx.moveSha = api.moveMain(w, { [rel]: `${body}\n// soak: smoke-github-outage main move\n` }, 'soak: touch reconcile-pass.mjs (smoke-github-outage)');
          api.say(`r${String(round).padStart(2, '0')} fake gh pr list now returns HTTP 502; main moved -> ${ctx.moveSha.slice(0, 9)} touching ${rel} — reconcile-dry-run cannot skip unchanged code`);
          return;
        }
        if (round !== JUDGE_ROUND) return;

        const adopted = spawnSync('git', ['merge-base', '--is-ancestor', ctx.moveSha, 'HEAD'], { cwd: w.simCloneRoot, stdio: 'ignore' }).status === 0;
        const rebuildPath = join(w.simCloneRoot, 'scripts/lib/daemon-rebuild.mjs');
        if (!existsSync(rebuildPath)) {
          api.violation('rebuild-state-unreadable', 'scripts/lib/daemon-rebuild.mjs is not in this tree');
          return;
        }
        const { readRebuildState } = await import(pathToFileURL(rebuildPath).href);
        const { daemonStateDir, cloneKeyOf } = await import(pathToFileURL(join(w.simCloneRoot, 'scripts/lib/daemon-last-good.mjs')).href);
        const state = readRebuildState(w.simCloneRoot, w.env);
        const alertsPath = join(daemonStateDir(w.env), `${cloneKeyOf(w.simCloneRoot)}.alerts.jsonl`);
        let alerts = [];
        try {
          alerts = readFileSync(alertsPath, 'utf8').split('\n').filter(Boolean)
            .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        } catch { /* no alerts file — nothing held/rejected */ }
        const kinds = alerts.map((a) => a.kind);

        if (state.rejected || kinds.includes('smoke-rejected')) {
          api.violation('reject-record-written', `a reject record was written for a GitHub outage — state.rejected=${JSON.stringify(state.rejected)}`);
        }
        const fallbackKinds = kinds.filter((kind) => /fallback|overlay-dropped.*smoke-failed/.test(kind));
        if (fallbackKinds.length) {
          api.violation('overlay-blamed-or-fallback', `a GitHub outage blamed overlays or triggered fallback: ${[...new Set(fallbackKinds)].join(', ')}`);
        }
        if (state.held?.reason === 'smoke-harness-broken' || kinds.includes('smoke-harness-broken')) {
          api.violation('held-as-harness-broken', `a GitHub outage was read as a broken smoke harness — held=${JSON.stringify(state.held?.reason ?? null)}`);
        }
        if (!adopted && state.held?.reason !== 'smoke-env-unavailable') {
          api.violation('not-held-as-env-unavailable', `the clone did not adopt ${ctx.moveSha.slice(0, 9)} and did not hold as environment — held=${JSON.stringify(state.held?.reason ?? null)}`);
        }
        api.say(`r${String(round).padStart(2, '0')} judge: adopted=${adopted} held=${JSON.stringify(state.held?.reason ?? null)} rejected=${!!state.rejected} alert kinds: ${[...new Set(kinds)].join(', ') || '(none)'}`);
      },
    });
    const root = new URL('../../../../', import.meta.url);
    const exhausted = await replayBudgetExhaustedOutage(fileURLToPath(root));
    const budgetSkips = exhausted.smoke?.results.filter((r) => !r.ok && /skipped: rebuild smoke budget exhausted/.test(r.detail));
    if (exhausted.verdict !== 'env-unavailable' || exhausted.attempts !== 2
      || !exhausted.githubEnv?.confirmed || !budgetSkips?.length) {
      report.violations.push({ invariant: 'budget-exhausted-outage-rejected',
        detail: `confirmed outage retry with budget refusals: verdict=${exhausted.verdict} attempts=${exhausted.attempts} skips=${budgetSkips?.length ?? 0}` });
    }
    return report;
  },
  judge(report) {
    return report.violations
      // Only this break's own findings, plus a world that crashed/hung/leaked (never a false GREEN).
      .filter((v) => SPECIFIC.has(v.invariant) || ['crash', 'bounded', 'isolation', 'no-throw'].includes(v.invariant))
      .map((v) => `${v.daemon ?? '-'} tick ${v.tick ?? '-'}: [${v.invariant}] ${v.detail}`);
  },
};
