/**
 * @file breaks/pinned-overlay-conflict-skipped.mjs — live incident, 2026-09-26 23:39 ET on `wev-review-daemon`
 * (#4075/#3383, card xpinskip). #2768 (lane/fix-rebuild-finalize) only CHANGES `scripts/lib/daemon-rebuild.mjs`,
 * a file main already carries, so the rebuild auto-pinned it (`pinnedBy:'mechanism'`). main moved, #2768
 * conflicted, and the rebuild refused (`pinned-overlay-conflict`) EVERY tick: the clone fell 2 commits behind
 * origin/main and the fix daemon refused ALL dispatch in all three repos as stale. One conflicting pinned overlay
 * froze the whole fleet.
 *
 * THE FIX (xpinskip, `daemon-rebuild.mjs#planRebuild` + `pinnedConflictSkippable`): a new pinned overlay that only
 * changes a mechanism main already runs is SKIPPED for this build (never dropped — it stays registered and
 * re-applies once its branch is rebased); the rebuild builds main + the other overlays, smokes as usual, and
 * alerts `pinned-overlay-conflict-skipped` naming it. An overlay that ADDS a mechanism file main lacks (the
 * 2026-09-25 #2625 self-destruct shape) or an explicit `--pinned` one still refuses — and then records the clone
 * as held on its last-good build so dispatch keeps going.
 * A carried overlay that conflicts also holds the clone: skipping it must never evict live changes (#5809).
 *
 * SCENARIO: a real overlay branch on `we` that appends one comment line to `scripts/lib/daemon-rebuild.mjs` (so
 * it is auto-pinned by mechanism) plus a file `soak/pinned-overlay-conflict.md`. Main adds that SAME path before
 * the first adoption: the newcomer is skipped, stays registered, and main advances. Repairing the branch lets it
 * apply; a second main conflict must HOLD that live build until another repair lets both main and the overlay
 * advance. Driven through the ordinary daemon tick loop, never a hand-called `rebuildClone()`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runSoak } from '../soak.mjs';
import { rebuildMechanismSource } from '../rebuild-mechanism-source.mjs';
import { cloneFacts } from '../invariants.mjs';

const OVERLAY_REF = 'lane/xpinskip-pinned-overlay-fixture';
const CONFLICT_PATH = 'soak/pinned-overlay-conflict.md';
const RECOVERY_PATH = 'soak/pinned-overlay-recovered.md';
const REGISTER_ROUND = 0;
const APPLY_ROUND = 2;
const CONFLICT_ROUND = 4;
const REPAIR_ROUND = 6;
const FINAL_ROUND = 9;

export default {
  id: 'pinned-overlay-conflict-skipped',
  title: 'a conflicting mechanism overlay is skipped before adoption, held once live, and adopted with main after repair while every daemon keeps dispatching',
  card: 'we:backlog/xpinskip (epic #4075) / PR #5809 live-overlay hold',
  fixedBy: {
    sha: '5809-live-pinned-overlay-hold',
    where: 'lane/overlay-pin',
    paths: ['scripts/lib/daemon-rebuild.mjs', 'scripts/lib/daemon-rebuild/plan.mjs', 'scripts/lib/daemon-rebuild/prepare.mjs', 'scripts/conveyor/health-smells/dispatch-refused-stale-clone.mjs'],
  },
  fixPresent(root) {
    try {
      const source = rebuildMechanismSource(root);
      return /pinnedConflictSkippable/.test(source) && /pinned-conflict-skipped/.test(source);
    } catch { return false; }
  },
  async run({ log } = {}) {
    const report = await runSoak({
      name: 'break:pinned-overlay-conflict-skipped',
      rounds: FINAL_ROUND + 1,
      mainEvery: 0,
      scorecards: false,
      log,
      setup(w) {
        if (!existsSync(join(w.simCloneRoot, 'scripts/lib/daemon-rebuild.mjs'))) {
          throw new Error('pinned-overlay-conflict-skipped: requires scripts/lib/daemon-rebuild.mjs — not present on this tree');
        }
        // Isolate the overlay list from the operator's real ~/.claude/daemon-overlays (see bad-overlay-falls-back).
        w.env.WE_DAEMON_OVERLAY_DIR = join(w.root, 'daemon-overlays');
        return {};
      },
      async perRound(w, round, ctx, api) {
        const say = (m) => api.say(`r${String(round).padStart(2, '0')} ${m}`);
        if (round === REGISTER_ROUND) {
          const overlaysModule = await import(pathToFileURL(join(w.simCloneRoot, 'scripts/lib/daemon-overlays.mjs')).href);
          const rebuildSrc = readFileSync(join(w.simCloneRoot, 'scripts/lib/daemon-rebuild.mjs'), 'utf8');
          const sha = w.git.createBranch('we', OVERLAY_REF, {
            from: 'main',
            files: {
              'scripts/lib/daemon-rebuild.mjs': `${rebuildSrc}// xpinskip soak fixture: a harmless mechanism change (auto-pins this overlay)\n`,
              [CONFLICT_PATH]: 'overlay side\n',
            },
          });
          ctx.overlaySha = sha;
          overlaysModule.addOverlay(w.simCloneRoot, { ref: OVERLAY_REF, pr: null }, { env: w.env });
          api.moveMain(w, { [CONFLICT_PATH]: 'main side\n' }, 'soak: main conflicts with a new pinned overlay');
          say(`registered mechanism overlay ${OVERLAY_REF} (${sha.slice(0, 9)}) and moved main — the newcomer should be skipped`);
          return;
        }
        if (round === APPLY_ROUND) {
          const rebuildModule = await import(pathToFileURL(join(w.simCloneRoot, 'scripts/lib/daemon-rebuild.mjs')).href);
          const state = rebuildModule.readRebuildState(w.simCloneRoot, w.env);
          const facts = cloneFacts({ clone: w.simCloneRoot, mainMoves: [api.mainMoves().at(-1).sha] });
          if (facts.behind > 0 || state.held || state.adopted?.applied?.some((o) => o.ref === OVERLAY_REF)) {
            api.violation('newcomer-not-skipped', 'a conflicting newcomer must let main adopt without holding the clone or applying the overlay');
          }
          ctx.overlaySha = w.git.createBranch('we', OVERLAY_REF, {
            from: OVERLAY_REF,
            files: { [CONFLICT_PATH]: 'main side\n', [RECOVERY_PATH]: 'first repair\n' },
          });
          say('repaired the newcomer conflict — the registered overlay should now apply');
          return;
        }
        if (round === CONFLICT_ROUND) {
          const facts = cloneFacts({ clone: w.simCloneRoot, mainMoves: [ctx.overlaySha] });
          if (facts.behind > 0) {
            api.violation('overlay-not-applied', 'the repaired overlay must be carried before the live conflict is introduced');
          }
          ctx.liveHead = facts.head;
          api.moveMain(w, { [CONFLICT_PATH]: 'main moved again\n' }, 'soak: main now conflicts with the live pinned overlay');
          say('moved main onto a conflicting change — the rebuild must hold the live overlay on its last-good build');
          return;
        }
        if (round === REPAIR_ROUND) {
          const rebuildModule = await import(pathToFileURL(join(w.simCloneRoot, 'scripts/lib/daemon-rebuild.mjs')).href);
          const state = rebuildModule.readRebuildState(w.simCloneRoot, w.env);
          const facts = cloneFacts({ clone: w.simCloneRoot, mainMoves: [api.mainMoves().at(-1).sha] });
          if (facts.head !== ctx.liveHead || facts.behind !== 1
            || state.held?.reason !== 'established-overlay-conflict' || state.held?.lastGood !== ctx.liveHead) {
            api.violation('live-overlay-not-held', 'a conflicting carried overlay must retain its exact last-good build and record the established-overlay hold');
          }
          ctx.overlaySha = w.git.createBranch('we', OVERLAY_REF, {
            from: OVERLAY_REF,
            files: { [CONFLICT_PATH]: 'main moved again\n', [RECOVERY_PATH]: 'second repair\n' },
          });
          say('repaired the live conflict — main and the registered overlay should now advance together');
          return;
        }
        if (round === FINAL_ROUND) {
          const overlaysModule = await import(pathToFileURL(join(w.simCloneRoot, 'scripts/lib/daemon-overlays.mjs')).href);
          const lastGoodModule = await import(pathToFileURL(join(w.simCloneRoot, 'scripts/lib/daemon-last-good.mjs')).href);
          const overlays = overlaysModule.readOverlayState(w.simCloneRoot, { env: w.env }).overlays;
          if (!overlays.some((o) => o.ref === OVERLAY_REF)) {
            api.violation('pinned-overlay-dropped', `the pinned overlay ${OVERLAY_REF} is no longer registered — skip must never drop it (list: ${overlays.map((o) => o.ref).join(', ') || '(empty)'})`);
          }
          const alertsPath = join(lastGoodModule.daemonStateDir(w.env), `${overlaysModule.cloneKey(w.simCloneRoot)}.alerts.jsonl`);
          let alertsText = '';
          try { alertsText = readFileSync(alertsPath, 'utf8'); } catch { /* reported below */ }
          const kinds = alertsText.split('\n').filter(Boolean)
            .map((l) => { try { return JSON.parse(l).kind; } catch { return null; } }).filter(Boolean);
          if (!kinds.includes('pinned-overlay-conflict-skipped')) {
            api.violation('missing-alert', `never alerted "pinned-overlay-conflict-skipped" — kinds seen: ${[...new Set(kinds)].join(', ') || '(none)'}`);
          }
          if (!kinds.includes('established-overlay-hold')) {
            api.violation('missing-alert', 'never alerted "established-overlay-hold" for the conflicting carried overlay');
          }
          const rebuildModule = await import(pathToFileURL(join(w.simCloneRoot, 'scripts/lib/daemon-rebuild.mjs')).href);
          const state = rebuildModule.readRebuildState(w.simCloneRoot, w.env);
          const recovered = cloneFacts({ clone: w.simCloneRoot, mainMoves: [ctx.overlaySha] });
          if (recovered.behind > 0 || state.held
            || state.adopted?.applied?.find((o) => o.ref === OVERLAY_REF)?.sha !== ctx.overlaySha
            || readFileSync(join(w.simCloneRoot, RECOVERY_PATH), 'utf8') !== 'second repair\n') {
            api.violation('overlay-not-recovered', 'the repaired overlay must be adopted with its content and clear the last-good hold');
          }
          const latestMain = api.mainMoves().at(-1)?.sha;
          const facts = latestMain ? cloneFacts({ clone: w.simCloneRoot, mainMoves: [latestMain] }) : null;
          if (!facts || facts.behind > 0) {
            api.violation('clone-not-on-latest-main', `the clone never adopted the latest main move ${String(latestMain).slice(0, 9)} — a conflicting pinned overlay still froze it`);
          }
        }
      },
    });
    return report;
  },
  judge(report) {
    return report.violations
      .filter((v) => [
        'clean', 'bounded', 'no-throw', 'no-onTick-crash', 'stale', 'owed', 'crash', 'lag',
        'pinned-overlay-dropped', 'missing-alert', 'clone-not-on-latest-main',
        'newcomer-not-skipped', 'overlay-not-applied', 'live-overlay-not-held', 'overlay-not-recovered',
      ].includes(v.invariant))
      .map((v) => `${v.daemon ?? '-'} tick ${v.tick ?? '-'}: [${v.invariant}] ${v.detail}`);
  },
};
