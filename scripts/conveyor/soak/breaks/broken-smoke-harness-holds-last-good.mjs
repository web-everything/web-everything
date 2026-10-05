/**
 * @file breaks/broken-smoke-harness-holds-last-good.mjs — live incident, 2026-09-26 12:11-12:40 ET on
 * `wev-review-daemon` (#4075/#3383, card 4217): every rebuild that window was `smoke-rejected`, STICKY, and
 * every dispatch chokepoint then refused as stale — a single bad main commit, a bad overlay, or (this scenario)
 * a broken smoke HARNESS ITSELF stopped all review/fix delivery until a human stepped in. The operator's ruling:
 * "fallback on last working version rather than block delivery".
 *
 * THE FIX (4217): `daemon-rebuild.mjs#smokeAndAdopt`'s branch (c) tells a broken CANDIDATE apart from a broken
 * HARNESS by smoking the clone's own last-good build (`prevHead`) as a control. When the control fails the exact
 * same checks the candidate failed (`failsSameChecks`), the failure is the smoke's own environment, not the new
 * code — `smoke-harness-broken`, recorded with a backoff (never sticky, never re-smoked every tick), and
 * `state.held` is written so the clone stays on its last-good build. `main-staleness.mjs#assertMainNotStale`
 * (via `daemon-last-good.mjs#lastGoodForClone`) then dispatches from that build instead of refusing it as stale —
 * so daemons keep dispatching owed work the whole time — and the health smell
 * `scripts/conveyor/health-smells/daemon-held-on-last-good.mjs` opens once the hold has sat past 15 minutes,
 * naming the failing check for whoever fixes the harness (never the clone by hand).
 *
 * SCENARIO: the harness is broken through the smoke's OWN env alone — `WE_SMOKE_TREE_STAYS_CLEAN_MS=1` — so
 * `daemon-live-smoke.mjs#checkTreeStaysClean`'s one `git status --porcelain` call can never finish that fast.
 * That check is deliberately the target, not `dispatch-dry-run`/`reconcile-dry-run`: it carries no `codeEntries`
 * (see `SMOKE_CHECKS`), so unlike those two it is NEVER skipped by the smoke's own skip-unchanged logic,
 * whatever files a main move touches — it fails identically on EVERY tree, the last-good build included, which
 * is exactly "the harness itself is broken". It is also `mayBeTransient:false`, so `classifySmokeFailure` reads
 * the failure as `'code'`, never `'transient'` (see that file's own Module D docs).
 *
 * SET IN `setup`, NOT MID-RUN: `scenario.mjs#bootHost` forks each daemon host ONCE, copying `w.env` into the
 * child's own `process.env` at that moment only — a later mutation of `w.env` never reaches an already-running
 * host (confirmed by reading `daemon-host.mjs`/`scenario.mjs`; neither re-reads `w.env` per tick). So the budget
 * is set from process start. The initial settle still passes fine: while `origin/main` hasn't moved,
 * `daemon-rebuild.mjs#prepareRebuild`'s `plan.upToDate` short-circuit never runs a live smoke at all (see that
 * file's own header) — the broken budget only bites once a real rebuild-and-smoke actually happens, at the
 * CODE-path main move below (a plain main move, so a managed clone behind on it would otherwise refuse as stale
 * — proving 4217's fallback dispatches from the held last-good build instead).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runSoak } from '../soak.mjs';
import { rebuildMechanismSource } from '../rebuild-mechanism-source.mjs';

const FAULT_ROUND = 3;
const FINAL_ROUND = 9;
const HELD_FOR_HEALTH_SMELL_MS = 16 * 60_000; // > the smell's own 15-minute `heldForMs` threshold

export default {
  id: 'broken-smoke-harness-holds-last-good',
  title: 'the live smoke harness itself is broken (fails every tree identically, the last-good build included); the rebuild tells that apart from a real regression, holds the clone on its last-good build, keeps dispatching, and the health smell names it',
  card: 'we:backlog/4217 (epic #4075)',
  fixedBy: {
    sha: '4217-daemon-last-good-fallback',
    where: 'lane/4217-daemon-last-good-fallback',
    paths: [
      'scripts/lib/daemon-rebuild.mjs',
      'scripts/lib/daemon-last-good.mjs',
      'scripts/lib/main-staleness.mjs',
      'scripts/conveyor/health-smells/daemon-held-on-last-good.mjs',
    ],
  },
  // fixPresent probe (per the brief): `smokeAndAdopt` in daemon-rebuild.mjs — the 4217 fallback/hold body.
  fixPresent(root) {
    try {
      return /smokeAndAdopt/.test(rebuildMechanismSource(root));
    } catch { return false; }
  },
  async run({ log } = {}) {
    const report = await runSoak({
      name: 'break:broken-smoke-harness-holds-last-good',
      rounds: FINAL_ROUND + 1,
      mainEvery: 0,
      scorecards: false,
      log,
      setup(w) {
        if (!existsSync(join(w.simCloneRoot, 'scripts/lib/daemon-rebuild.mjs'))) {
          throw new Error('broken-smoke-harness-holds-last-good: requires scripts/lib/daemon-rebuild.mjs (lands with 4218/4217) — not present on this tree');
        }
        // See file header: baked in BEFORE any daemon host forks, so both the eventual candidate smoke and the
        // control (last-good) smoke inherit the SAME broken budget — the whole point of "the harness is broken,
        // not the code".
        w.env.WE_SMOKE_TREE_STAYS_CLEAN_MS = '1';
        // A broken harness now adopts the candidate as no worse by default; this scenario pins the opt-out
        // hold-on-last-good path (WE_DAEMON_HARNESS_BROKEN_ADOPT_NOT_WORSE=0).
        w.env.WE_DAEMON_HARNESS_BROKEN_ADOPT_NOT_WORSE = '0';
        return {};
      },
      async perRound(w, round, ctx, api) {
        if (round === FAULT_ROUND) {
          // A CODE-path move (matches `main-staleness.mjs#isCodePath` — extension-based, never tied to an
          // import graph) — a managed clone behind on it would otherwise refuse dispatch as stale; this proves
          // 4217's fallback dispatches from the held last-good build instead. The fixture file is not
          // imported by anything, so it cannot itself trip the daemons' own restart-on-import-changed gate.
          api.moveMain(w, {
            'scripts/conveyor/soak/fixtures/main-move-broken-harness.mjs': 'export const MAIN_MOVE = 1;\n',
          }, 'soak: code-path main move for broken-smoke-harness-holds-last-good');
          api.say(`r${String(round).padStart(2, '0')} moved main (code-path) with the smoke harness pre-broken (WE_SMOKE_TREE_STAYS_CLEAN_MS=1) — the next rebuild should smoke-fail identically on the candidate AND the last-good control, and hold`);
          return;
        }
        if (round === FINAL_ROUND) {
          const rebuildModule = await import(pathToFileURL(join(w.simCloneRoot, 'scripts/lib/daemon-rebuild.mjs')).href);
          const overlaysModule = await import(pathToFileURL(join(w.simCloneRoot, 'scripts/lib/daemon-overlays.mjs')).href);
          const lastGoodModule = await import(pathToFileURL(join(w.simCloneRoot, 'scripts/lib/daemon-last-good.mjs')).href);
          const healthWatchModule = await import(pathToFileURL(join(w.simCloneRoot, 'scripts/conveyor/health-watch.mjs')).href);
          const smellModule = await import(pathToFileURL(join(w.simCloneRoot, 'scripts/conveyor/health-smells/daemon-held-on-last-good.mjs')).href);
          const { cloneKey } = overlaysModule;
          const { daemonStateDir } = lastGoodModule;
          const { probeSelfSync } = healthWatchModule;
          const smell = smellModule.default;

          const key = cloneKey(w.simCloneRoot);
          const stateDir = daemonStateDir(w.env);

          const state = rebuildModule.readRebuildState(w.simCloneRoot, w.env);
          if (state.held?.reason !== 'smoke-harness-broken') {
            api.violation('not-held-as-harness-broken', `state.held.reason is ${JSON.stringify(state.held?.reason ?? null)} (expected "smoke-harness-broken") — full held record: ${JSON.stringify(state.held)}`);
          }

          const alertsPath = join(stateDir, `${key}.alerts.jsonl`);
          let alertsText = '';
          try { alertsText = readFileSync(alertsPath, 'utf8'); } catch { /* nothing written — every kind below is then reported missing */ }
          const kinds = alertsText.split('\n').filter(Boolean)
            .map((l) => { try { return JSON.parse(l).kind; } catch { return null; } }).filter(Boolean);
          for (const need of ['smoke-harness-broken', 'daemon-held-on-last-good']) {
            if (!kinds.includes(need)) {
              api.violation('missing-alert', `the clone's alerts file (${alertsPath}) never recorded "${need}" — kinds seen: ${[...new Set(kinds)].join(', ') || '(none)'}`);
            }
          }

          const selfSync = probeSelfSync(stateDir);
          const row = selfSync.find((c) => c.cloneKey === key);
          const since = row?.rebuild?.held?.since;
          if (since == null) {
            api.violation('health-smell-no-since', `probeSelfSync(${stateDir}) reported no held.since for clone ${key} — cannot evaluate the health smell`);
          } else {
            const now = since + HELD_FOR_HEALTH_SMELL_MS;
            const rows = smell.evaluate({ selfSync }, { now });
            const smellRow = rows.find((r) => r.subject === `clone:${key}`);
            if (!smellRow?.breach) {
              api.violation('health-smell-no-breach', `daemon-held-on-last-good.evaluate() did not breach at now=since+16min for clone ${key}: ${JSON.stringify(smellRow)}`);
            } else if (!/tree-stays-clean/.test(String(smellRow.measure?.failedChecks || ''))) {
              api.violation('health-smell-missing-check', `the breach did not name the failing check (tree-stays-clean) — measure: ${JSON.stringify(smellRow.measure)}`);
            }
          }
        }
      },
    });
    return report;
  },
  judge(report) {
    return report.violations
      // 'lag'/'behind' are EXPECTED here — the clone is DELIBERATELY held off origin/main by the broken harness;
      // only a refusal to dispatch (stale), a crash, or owed work with no dispatch means the fallback failed.
      .filter((v) => [
        'clean', 'bounded', 'no-throw', 'no-onTick-crash', 'stale', 'owed', 'crash',
        'not-held-as-harness-broken', 'missing-alert', 'health-smell-no-since', 'health-smell-no-breach', 'health-smell-missing-check',
      ].includes(v.invariant))
      .map((v) => `${v.daemon ?? '-'} tick ${v.tick ?? '-'}: [${v.invariant}] ${v.detail}`);
  },
};
