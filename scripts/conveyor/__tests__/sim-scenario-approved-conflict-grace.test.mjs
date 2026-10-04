/**
 * @file sim-scenario-approved-conflict-grace.test.mjs — epic #3383, scenario I-07 (report "First three
 * scenarios" row B). Fix under test: commit `77d560101`, `scripts/conveyor/parked-pr-conflict-watch.mjs` — the
 * approved/queued-conflict branch ({@link isQueuedConflictTarget}) plus the 30-minute drain grace
 * ({@link QUEUED_CONFLICT_GRACE_MS}).
 *
 * SETUP: a PR on a lane branch (`lane/2501-conflict-fixture`), labelled `review:accepted`, whose head touches
 * `a.txt`; `main` then gets a conflicting commit to the SAME file (real git, real conflict against the sim
 * origin — `git merge-tree` is what `mergeable: CONFLICTING` is computed from, never canned).
 *
 * A backlog fixture card (`WE_BACKLOG_DIR/2501-conflict-fixture.md`, `scope: [we:a.txt]`) is required for the
 * fix dispatch: the PR's branch name (`lane/2501-...`) makes `laneRefItemNum` resolve item `2501`, and
 * `reconcile-fix-dispatch.mjs#planFixesFromReconcile` refuses `no-scope` for a resolved item with no scope
 * (never widening the fence to the PR's own diff for a NAMED item — that fallback is item-less-PR only). This
 * card had to ALSO be made resolvable at all: {@link ../sim/world.mjs}'s WE template did not carry
 * `src/_data/backlog.js` (the canonical backlog loader every daemon imports FROM THE SIM CLONE), so `findItem`
 * silently read every item as unresolvable — a harness gap fixed at its root there (see that file's own note).
 *
 * PLAY, matching the design report's own worked example almost verbatim:
 *   1. `tick conflict-watch` — the approved/queued conflict is detected and labelled + commented AT ONCE (never
 *      bounced yet — the drain gets first try).
 *   2. `advance 31m`, `tick conflict-watch` — the grace has elapsed with the drain never healing it (nothing in
 *      this world runs the drain): bounced to `review:changes` with a real finding comment; `review:accepted`
 *      is stripped.
 *   3. `tick fix-dispatch` (twice — see below) — dispatches exactly ONE `fix-<pr>` session through the REAL
 *      `reconcile-fix-dispatch.mjs`.
 *   4. The scripted fix session resolves the conflict for real (`resolveConflictAndPush`) and re-arms the PR
 *      the way the REAL fix-agent brief does for an ordinary main-base conflict-fix round: `rearm-review.mjs
 *      --round=conflict` (agent-actions.mjs's `rearm({round:'conflict'})`) — NOT `conflict-fix-mark.mjs`, which
 *      is the STACKED-BASE sibling for a PR conflicting against another lane's base, a different population
 *      (see that file's own header) than this scenario's ordinary main-base conflict.
 *   5. `agents` (x3) steps the three queued actions one at a time, then `tick conflict-watch` sees
 *      `mergeable: MERGEABLE` and self-heals: the conflict label is removed (no comment — self-healing, per
 *      the file's own docblock) and — since the fix session already rearmed the PR itself — there is nothing
 *      left for the watch's own `postRearm` branch to do (gated on `review:changes` still being present).
 *
 * `tick fix-dispatch` NEEDS TWO CALLS the first time it ever runs in THIS scenario, not because of anything
 * this scenario is proving: `w.git.commitToMain` during `setup()` (the conflicting main-side commit) lands
 * BEFORE the fix-dispatch daemon host ever boots, so its own tick-start self-sync (unrelated to this scenario,
 * covered by `sim-scenario-self-sync-sibling.test.mjs`) finds itself behind, merges, passes the live smoke
 * gate, and restarts on its FIRST tick — exactly like any daemon that boots after main has already moved. The
 * SECOND call is the one that actually reaches the real dispatch pass.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scenario, runScenario } from './sim/scenario.mjs';
import { CONFLICT_LABEL, QUEUED_CONFLICT_GRACE_MS } from '../parked-pr-conflict-watch.mjs';

const WE_SLUG = 'web-everything/web-everything';
const BRANCH = 'lane/2501-conflict-fixture';
const ITEM_NUM = '2501';

function labelNames(pr) {
  return pr.labels.map((l) => l.name);
}

function fetchEvents(env, pr) {
  const out = execFileSync('gh', ['api', `repos/${WE_SLUG}/issues/${pr}/events`, '--jq', '.'], {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out || '[]');
}

function def() {
  // Play-array function steps (`scenario.mjs#runStep`) are only ever handed `w`, never the `setup()` return
  // value (that is `expect`'s own second argument) — so a mid-scenario assertion closure that needs the PR
  // number captures it from this outer binding instead, populated once `setup()` runs.
  let prNumber = null;
  return scenario('approved-conflict-grace', {
    repos: ['we'],
    daemons: ['conflict-watch', 'fix-dispatch'],
    lanes: 2,
    // A big, distinctive offset so "the labeled event carries SIM time" is actually falsifiable — a plain
    // `Date.now()` at offset 0 would look the same whether or not the clock preload propagated at all.
    clockStartOffsetMs: 2 * 24 * 3600 * 1000,
    setup(w) {
      w.git.createBranch('we', BRANCH, { from: 'main', files: { 'a.txt': 'pr side\n' } });
      const pr = w.gh.openPr({
        repo: 'we', head: BRANCH, base: 'main', title: 'conflict fixture (I-07)', labels: ['review:accepted'],
      });
      // Real conflict: main touches the SAME file the PR's own head already changed.
      w.git.commitToMain('we', { 'a.txt': 'main side\n' }, 'sim: b main-side conflicting commit');

      // The item card scope must resolve (`laneRefItemNum('lane/2501-...') === '2501'`) — see file header.
      mkdirSync(w.backlogDir, { recursive: true });
      writeFileSync(join(w.backlogDir, `${ITEM_NUM}-conflict-fixture.md`), [
        '---',
        'type: task',
        'status: open',
        'dateOpened: 2026-09-01',
        'scope:',
        '  - we:a.txt',
        '---',
        '# Conflict fixture item (I-07)',
        '',
        'Fixture backlog card for the daemon scenario simulator — not a real backlog item.',
        '',
      ].join('\n'), 'utf8');

      // The real sequence an ordinary (non-stacked) main-base conflict-fix round's own brief runs: resolve,
      // then the SAME `rearm-review.mjs --round=conflict` hand-back an ordinary repaired bounce uses.
      w.agents.script('fix-*', [
        w.act.resolveConflictAndPush(),
        w.act.rearm({ round: 'conflict' }),
        w.act.exit({ state: 'done' }),
      ]);
      prNumber = pr;
      return { w, pr };
    },
    play: [
      'tick conflict-watch',
      (w) => {
        const pr = prNumber;
        const row = w.gh.pr('we', pr);
        const names = labelNames(row);
        expect(names).toContain(CONFLICT_LABEL);
        expect(names).toContain('review:accepted'); // not bounced yet — the drain gets first try
        expect(names).not.toContain('review:changes');

        const events = fetchEvents(w.env, pr);
        const labeled = events.find((e) => e.event === 'labeled' && e.label?.name === CONFLICT_LABEL);
        expect(labeled).toBeTruthy();
        // "carries sim time": within a generous real-wall-clock tolerance of the SIM clock's own `now()`
        // (offset +2 days from real now) — a value that could only match if the fake clock preload actually
        // reached the `gh` shim process that wrote it, not the real wall clock.
        const eventMs = Date.parse(labeled.created_at);
        expect(Math.abs(eventMs - w.clock.now())).toBeLessThan(60_000);
        expect(Math.abs(eventMs - Date.now())).toBeGreaterThan(60_000 * 60); // NOT real time
      },
      'advance 31m',
      'tick conflict-watch',
      (w) => {
        const pr = prNumber;
        expect(QUEUED_CONFLICT_GRACE_MS).toBe(30 * 60 * 1000); // the grace this 31m advance is proving out
        const row = w.gh.pr('we', pr);
        const names = labelNames(row);
        expect(names).toContain('review:changes');
        expect(names).not.toContain('review:accepted');
        expect(names).toContain(CONFLICT_LABEL); // still present — only cleared on confirmed resolution
        expect(row.comments.length).toBeGreaterThan(0);
        expect(row.comments.some((c) => /merge conflict/i.test(c.body) || /Resolving the conflict IS the task/.test(c.body))).toBe(true);
      },
      // See file header: the first call after `setup()`'s own `commitToMain` just self-syncs + restarts.
      'tick fix-dispatch',
      'tick fix-dispatch',
      (w) => {
        const pr = prNumber;
        const fixSessions = w.claude.sessions().filter((s) => /^fix-\d+$/.test(s.name));
        expect(fixSessions).toHaveLength(1);
        expect(fixSessions[0].name).toBe(`fix-${pr}`);
      },
      'agents', 'agents', 'agents',
      'tick conflict-watch',
    ],
    expect(s, { pr }) {
      const row = s.pr(pr, 'we');
      expect(row).toBeTruthy();
      expect(row.labels).not.toContain(CONFLICT_LABEL); // self-healed: mergeable flipped back to MERGEABLE
      expect(row.labels).not.toContain('review:changes'); // rearmed by the fix session itself
      expect(row.labels).toContain('review:pending'); // re-armed for a fresh independent review
      expect(row.labels).not.toContain('review:accepted'); // the old approval never rides through unreviewed

      expect(s.sessions('fix-*')).toHaveLength(1);
      expect(s.sessions('fix-*')[0].state).toBe('done');
    },
  });
}

describe('#3383 daemon scenario simulator — approved PR conflict grace (I-07)', () => {
  it('labels at once, bounces after the drain grace, dispatches one fixer, and self-heals on resolve', async () => {
    await runScenario(def(), { timeoutMs: 180_000 });
  }, 180_000);
});
