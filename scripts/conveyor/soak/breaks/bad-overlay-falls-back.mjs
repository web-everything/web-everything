/**
 * @file breaks/bad-overlay-falls-back.mjs — live incident, 2026-09-26 12:11-12:40 ET on `wev-review-daemon`
 * (#4075/#3383, card 4217). Every rebuild that tick was `smoke-rejected`, STICKY — the clone never adopted a
 * single new build for the whole window, because the daemon-rebuild mechanism (`scripts/lib/daemon-rebuild.mjs`)
 * had no notion of "the OVERLAY is the thing that's broken, not main itself". The operator's ruling: "fallback on
 * last working version rather than block delivery" — a failed update must never freeze delivery.
 *
 * THE FIX (4217, `smokeAndAdopt`'s branch (a)): when candidate A (`main` + every registered overlay) fails
 * the live smoke with a genuine `'code'` verdict, and A actually carries at least one NON-pinned overlay, the
 * rebuild builds candidate B = `main` + PINNED overlays only and smokes THAT. B passing means the non-pinned
 * overlay(s) are exactly what broke it: adopt B, drop every suspect overlay from the list (never bisected when
 * there is more than one), and alert `fallback-plain-main` (the retry) + `overlay-dropped-smoke-failed` (the
 * drop) — so the very next tick already dispatches from a WORKING build, and a human fixes the dropped overlay
 * on its own time instead of the whole clone freezing on it.
 *
 * SCENARIO: a real overlay branch on `we` whose one commit poisons `scripts/conveyor/reconcile-pass.mjs` (throws
 * at import — a plain parse/require failure, not a runtime condition) — this breaks ONLY the live smoke's
 * `reconcile-dry-run` check (`daemon-live-smoke.mjs#checkReconcileDryRun` runs this exact file as a child
 * process, once per constellation repo) and touches NOTHING in `daemon-rebuild.mjs#REBUILD_MECHANISM_PATHS`, so
 * it is never auto-pinned. Registered on the REAL daemon clone's overlay list (`daemon-overlays.mjs#addOverlay`)
 * alongside a real `origin/main` move, through the ordinary review/fix-dispatch daemon tick loop — never a
 * hand-driven `rebuildClone()` call. RED (pre-fix main, which has no `daemon-rebuild.mjs` at all) would simply
 * not apply here; GREEN (this tree) proves the clone falls back to plain `main`, drops the bad overlay, and both
 * daemons keep dispatching the whole time — never blocked on the bad fix.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runSoak } from '../soak.mjs';
import { rebuildMechanismSource } from '../rebuild-mechanism-source.mjs';
import { cloneFacts } from '../invariants.mjs';

const OVERLAY_REF = 'lane/4217-bad-overlay-fixture';
const FAULT_ROUND = 3;
const FINAL_ROUND = 9;

// A plain top-level throw — a real parse/import failure a bad overlay could actually ship, never a stub that
// merely returns a bad value. Deliberately does NOT touch `daemon-rebuild.mjs#REBUILD_MECHANISM_PATHS` (it isn't
// even in the same directory), so `pinnedStatus()` reads this overlay as NOT pinned — the fallback path this
// break exercises only ever runs for a non-pinned overlay.
const POISONED_RECONCILE_PASS = `// 4217 soak fixture (bad-overlay-falls-back, #4075) — this overlay intentionally poisons
// reconcile-pass.mjs so the live smoke's 'reconcile-dry-run' check fails with a genuine code-shaped error.
// Never touches daemon-rebuild.mjs's REBUILD_MECHANISM_PATHS, so this overlay is never auto-pinned.
throw new Error('4217-bad-overlay-falls-back: reconcile-pass.mjs poisoned by a bad overlay (soak fixture)');
`;

export default {
  id: 'bad-overlay-falls-back',
  title: "a bad (non-pinned) overlay breaks the daemon rebuild's live smoke; the rebuild falls back to plain main, drops the overlay, and both daemons keep dispatching the whole time",
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
      name: 'break:bad-overlay-falls-back',
      rounds: FINAL_ROUND + 1,
      mainEvery: 0,
      scorecards: false,
      log,
      setup(w) {
        if (!existsSync(join(w.simCloneRoot, 'scripts/lib/daemon-rebuild.mjs'))) {
          throw new Error('bad-overlay-falls-back: requires scripts/lib/daemon-rebuild.mjs (lands with 4218/4217) — not present on this tree');
        }
        // ISOLATE THE OVERLAY LIST. Unlike WE_DAEMON_STATE_DIR/WE_DAEMON_SMOKE_STATE_DIR (world.mjs scopes both
        // already), world.mjs never sets WE_DAEMON_OVERLAY_DIR — left unset, `daemon-overlays.mjs#overlayDir`
        // falls back to the REAL `~/.claude/daemon-overlays`, and this scenario's fixture overlay would register
        // against the operator's own real daemon-overlays store. Set here in `setup`, before any daemon host
        // ever forks (`scenario.mjs#bootHost` copies `w.env` into the child's env ONCE, at boot — a later
        // mutation would never reach an already-running host).
        w.env.WE_DAEMON_OVERLAY_DIR = join(w.root, 'daemon-overlays');
        return {};
      },
      async perRound(w, round, ctx, api) {
        if (round === FAULT_ROUND) {
          const overlaysModule = await import(pathToFileURL(join(w.simCloneRoot, 'scripts/lib/daemon-overlays.mjs')).href);
          const branchSha = w.git.createBranch('we', OVERLAY_REF, {
            files: { 'scripts/conveyor/reconcile-pass.mjs': POISONED_RECONCILE_PASS },
          });
          overlaysModule.addOverlay(w.simCloneRoot, { ref: OVERLAY_REF, pr: null }, { env: w.env });
          api.moveMain(w, {
            'soak/bad-overlay-falls-back.md': '# advance main for bad-overlay-falls-back\n',
          }, 'soak: advance main for bad-overlay-falls-back');
          api.say(`r${String(round).padStart(2, '0')} registered bad overlay ${OVERLAY_REF} (${branchSha.slice(0, 9)}) onto the clone's overlay list and moved main — the next rebuild should smoke-fail, fall back to plain main, and drop it`);
          return;
        }
        if (round === FINAL_ROUND) {
          const overlaysModule = await import(pathToFileURL(join(w.simCloneRoot, 'scripts/lib/daemon-overlays.mjs')).href);
          const lastGoodModule = await import(pathToFileURL(join(w.simCloneRoot, 'scripts/lib/daemon-last-good.mjs')).href);
          const { cloneKey } = overlaysModule;
          const { daemonStateDir } = lastGoodModule;

          const overlays = overlaysModule.readOverlayState(w.simCloneRoot, { env: w.env }).overlays;
          if (overlays.some((o) => o.ref === OVERLAY_REF)) {
            api.violation('overlay-not-dropped', `the bad overlay ${OVERLAY_REF} is STILL registered after ${FINAL_ROUND - FAULT_ROUND} rounds — the smoke-failed fallback never dropped it (overlay list: ${overlays.map((o) => o.ref).join(', ') || '(empty)'})`);
          }

          const alertsPath = join(daemonStateDir(w.env), `${cloneKey(w.simCloneRoot)}.alerts.jsonl`);
          let alertsText = '';
          try { alertsText = readFileSync(alertsPath, 'utf8'); } catch { /* nothing written — every kind below is then reported missing */ }
          const kinds = alertsText.split('\n').filter(Boolean)
            .map((l) => { try { return JSON.parse(l).kind; } catch { return null; } }).filter(Boolean);
          for (const need of ['fallback-plain-main', 'overlay-dropped-smoke-failed']) {
            if (!kinds.includes(need)) {
              api.violation('missing-alert', `the clone's alerts file (${alertsPath}) never recorded "${need}" — kinds seen: ${[...new Set(kinds)].join(', ') || '(none)'}`);
            }
          }

          const latestMain = api.mainMoves().at(-1)?.sha;
          const facts = latestMain ? cloneFacts({ clone: w.simCloneRoot, mainMoves: [latestMain] }) : null;
          if (facts && facts.behind > 0) {
            api.violation('clone-not-on-latest-main', `the clone's HEAD (${facts.head.slice(0, 9)}) does not contain the latest main move ${String(latestMain).slice(0, 9)} — the fallback never adopted it`);
          } else if (!facts) {
            api.violation('clone-not-on-latest-main', 'no main move was tracked to check the clone against');
          }
        }
      },
    });
    return report;
  },
  judge(report) {
    return report.violations
      .filter((v) => [
        'clean', 'bounded', 'no-throw', 'no-onTick-crash', 'stale', 'owed', 'crash',
        'overlay-not-dropped', 'missing-alert', 'clone-not-on-latest-main',
      ].includes(v.invariant))
      .map((v) => `${v.daemon ?? '-'} tick ${v.tick ?? '-'}: [${v.invariant}] ${v.detail}`);
  },
};
