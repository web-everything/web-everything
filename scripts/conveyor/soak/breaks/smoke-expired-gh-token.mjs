/**
 * @file breaks/smoke-expired-gh-token.mjs — live incident, 2026-09-26 21:22Z on `wev-review-daemon` (#4075/#3383,
 * fix PR #2771, branch `lane/fix-smoke-github-auth`). The rebuild held the clone on last-good `052409fd` as
 * `smoke-harness-broken`: `reconcile-dry-run` and `dispatch-dry-run` failed with `HTTP 401: Bad credentials`, the
 * last-good control failed the same way, and no main move (or overlay fix) could be adopted until a rebuild
 * happened to start with a still-valid token 30 minutes later.
 *
 * MECHANISM. A daemon's `main()` composes `withSelfSync(withGithubAppAuth(effects))`, so every tick runs the
 * rebuild (and its live smoke, `daemon-live-smoke.mjs#runLiveSmokeWithRetry`, called from
 * `daemon-rebuild.mjs#smokeAndAdopt`) BEFORE that tick refreshes the GitHub App token. The smoke copies
 * `process.env`, so it inherits whatever `GH_TOKEN` the PREVIOUS refresh left — past its 1h expiry after a long
 * tick or a run of skipped ticks. `gh-api-repo`/`gh-pr-list` still pass (sanitized env + the App shim, which reads
 * the shared token cache fresh), but `reconcile-dry-run`/`dispatch-dry-run` run tree code with the RAW env, get a
 * 401, and — being `mayBeTransient:false` — classify as `'code'`. The last-good control fails identically, so
 * `failsSameChecks` reads it as `smoke-harness-broken`: a reject record, a hold, no adoption.
 *
 * THE FIX (PR #2771): `runLiveSmokeWithRetry` refreshes the App token into a COPY of the smoke env before EVERY
 * attempt (`refreshSmokeGithubEnv` → the same `ensureFreshGithubAppEnv` the tick runs); a 401 in a failed row
 * triggers an external `gh api repos/<we>` probe with that env — probe 401 ⇒ forced re-mint + one retry, then an
 * `'auth-broken'` verdict, which `smokeAndAdopt` holds on as `github-auth-broken` with NO reject record and no
 * fallback/control smokes. An expired token is ENVIRONMENT, never evidence against the candidate.
 *
 * SCENARIO (review daemon only, no fleet — the break is the clone's own rebuild, not dispatch):
 *   setup  — App auth is configured in the sim world the way `gh-shim-mid-rebuild` does it (the three
 *            `WE_GITHUB_APP_*` vars + a dummy key file; nothing is ever minted), and the shared token cache under
 *            the world's fake HOME (`github-app-auth-env.mjs#defaultCachePath`) holds a valid token A. The
 *            daemon's r0 tick settles (origin/main unmoved ⇒ no smoke) and its `withGithubAppAuth` leaves
 *            `process.env.GH_TOKEN = A` in the long-lived host process.
 *   r1     — "an hour passes": token A expires (the fake `gh` now answers `HTTP 401: Bad credentials` for it —
 *            `w.gh.revokeToken`) and the fleet's shared cache already holds a fresh token B (another process's
 *            refresh — exactly the state a real refresh reads). Main moves with a one-line touch of
 *            `scripts/conveyor/reconcile-pass.mjs`, so the smoke's skip-unchanged logic can never skip the two
 *            raw-env rows whatever `changedSince` computes. The r1 tick's rebuild then smokes with stale A.
 *   r2     — the judge reads the clone's rebuild state + alerts file and whether the move was adopted.
 *
 * RED (pre-fix, main): the candidate smoke fails `reconcile-dry-run`/`dispatch-dry-run` with 401 ⇒ `'code'` ⇒
 *   a `smoke-rejected` record, the last-good control fails the same rows ⇒ `smoke-harness-broken` hold, and the
 *   main move is NOT adopted. GREEN (fix): the smoke's own per-attempt refresh hands it token B, the smoke passes,
 *   the clone adopts the move on the very tick it landed, no hold, no reject record, no harness-broken alert.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runSoak } from '../soak.mjs';
import { installationCachePath, OWNER_INSTALLATIONS } from '../../../lib/github-app-installations.mjs';

const MOVE_ROUND = 1;
const JUDGE_ROUND = 2;
const TOKEN_A = 'sim-app-token-A-expires';
const TOKEN_B = 'sim-app-token-B-fresh';
/** Far past any sim-clock offset — only the fake `gh`'s revocation decides which token is "expired". */
const FAR_EXPIRY = '2099-01-01T00:00:00.000Z';

/** Write the shared App token cache exactly as `github-app-auth-env.mjs#writeCacheFile` would (CACHE_VERSION 2). */
function writeTokenCache(w, token) {
  const dir = join(w.home, '.claude', 'github-app-token');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'web-everything.json');
  const cached = JSON.stringify({ v: 2, token, expiresAt: FAR_EXPIRY,
    appId: w.env.WE_GITHUB_APP_ID, installationId: w.env.WE_GITHUB_APP_INSTALLATION_ID });
  writeFileSync(path, cached, 'utf8');
  // The refresh and the guarded smoke both select by owner. Rotate that cache alongside the
  // legacy cache, so neither path retains revoked A after the simulated shared refresh to B.
  writeFileSync(installationCachePath(path, w.env.WE_GITHUB_APP_INSTALLATION_ID), cached, 'utf8');
}

const SPECIFIC = new Set([
  'held-as-harness-broken', 'reject-record-written', 'main-move-not-adopted', 'rebuild-state-unreadable',
]);

export default {
  id: 'smoke-expired-gh-token',
  title: "the rebuild's live smoke inherits the previous tick's expired GH_TOKEN (it runs before the tick's own App-token refresh); the raw-env reconcile/dispatch dry-runs 401, read as a code failure on the candidate AND last-good, and the clone is held as smoke-harness-broken instead of adopting main",
  card: 'PR #2771 (lane/fix-smoke-github-auth), epic #4075',
  fixedBy: {
    sha: '0b93031aa',
    where: 'lane/fix-smoke-github-auth',
    paths: [
      'scripts/lib/daemon-live-smoke.mjs',
      'scripts/lib/daemon-rebuild.mjs',
      'scripts/conveyor/health-smells/daemon-held-on-last-good.mjs',
    ],
  },
  // fixPresent probe: the per-attempt token refresh PR #2771 adds to daemon-live-smoke.mjs.
  fixPresent(root) {
    try {
      return /export async function refreshSmokeGithubEnv/.test(readFileSync(join(root, 'scripts/lib/daemon-live-smoke.mjs'), 'utf8'));
    } catch { return false; }
  },
  async run({ log } = {}) {
    return runSoak({
      name: 'break:smoke-expired-gh-token',
      rounds: JUDGE_ROUND + 1,
      daemons: ['review'],
      mainEvery: 0,
      fleet: false,
      scorecards: false,
      log,
      setup(w) {
        // Baked in BEFORE the daemon host forks (a host copies `w.env` once, at fork).
        Object.assign(w.env, {
          WE_GITHUB_APP_ID: '123456',
          WE_GITHUB_APP_INSTALLATION_ID: '654321',
          WE_GITHUB_APP_INSTALLATIONS: JSON.stringify(Object.fromEntries(
            Object.keys(OWNER_INSTALLATIONS).map(owner => [owner, '654321']))),
          WE_DELIVERY_IDENTITY: 'none',
          WE_GITHUB_APP_PRIVATE_KEY_PATH: join(w.home, 'app-key.pem'),
        });
        mkdirSync(w.home, { recursive: true });
        writeFileSync(w.env.WE_GITHUB_APP_PRIVATE_KEY_PATH, '-----BEGIN FAKE KEY-----\n(not a real key — the cache is always fresh, nothing is minted)\n');
        writeTokenCache(w, TOKEN_A);
        return {};
      },
      async perRound(w, round, ctx, api) {
        if (round === MOVE_ROUND) {
          w.gh.revokeToken(TOKEN_A);
          writeTokenCache(w, TOKEN_B);
          const rel = 'scripts/conveyor/reconcile-pass.mjs';
          const body = readFileSync(join(w.simCloneRoot, rel), 'utf8');
          ctx.moveSha = api.moveMain(w, { [rel]: `${body}\n// soak: smoke-expired-gh-token main move\n` }, 'soak: touch reconcile-pass.mjs (smoke-expired-gh-token)');
          api.say(`r${String(round).padStart(2, '0')} token A expired (fake gh 401s it), cache now holds fresh token B; main moved -> ${ctx.moveSha.slice(0, 9)} touching ${rel} — the rebuild smoke runs before this tick's own token refresh`);
          return;
        }
        if (round !== JUDGE_ROUND) return;

        const adopted = spawnSync('git', ['merge-base', '--is-ancestor', ctx.moveSha, 'HEAD'], { cwd: w.simCloneRoot, stdio: 'ignore' }).status === 0;
        if (!adopted) {
          api.violation('main-move-not-adopted', `the clone did not adopt main move ${ctx.moveSha.slice(0, 9)} on the tick it landed — an expired smoke token blocked it`);
        }

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

        if (state.held?.reason === 'smoke-harness-broken' || kinds.includes('smoke-harness-broken')) {
          const hb = alerts.find((a) => a.kind === 'smoke-harness-broken');
          api.violation('held-as-harness-broken', `the expired token was read as a broken smoke harness — held=${JSON.stringify(state.held?.reason ?? null)}, failed=${hb?.detail?.failed ?? state.held?.failed ?? '?'}, detail: ${JSON.stringify(hb?.detail?.details?.[0] ?? state.held?.details?.[0] ?? null).slice(0, 300)}`);
        }
        if (state.rejected || kinds.includes('smoke-rejected')) {
          api.violation('reject-record-written', `a reject record was written for an environment fault — state.rejected=${JSON.stringify(state.rejected)}`);
        }
        api.say(`r${String(round).padStart(2, '0')} judge: adopted=${adopted} held=${JSON.stringify(state.held?.reason ?? null)} rejected=${!!state.rejected} alert kinds: ${[...new Set(kinds)].join(', ') || '(none)'}`);
      },
    });
  },
  judge(report) {
    return report.violations
      // Only this break's own findings, plus a world that crashed/hung/leaked (never a false GREEN).
      .filter((v) => SPECIFIC.has(v.invariant) || ['crash', 'bounded', 'isolation', 'no-throw'].includes(v.invariant))
      .map((v) => `${v.daemon ?? '-'} tick ${v.tick ?? '-'}: [${v.invariant}] ${v.detail}`);
  },
};
