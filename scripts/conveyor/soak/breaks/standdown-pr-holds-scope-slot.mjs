/**
 * @file breaks/standdown-pr-holds-scope-slot.mjs — live break, 2026-10-03. A PR whose fix agent STOOD DOWN
 * (needs-judgment, terminal until an operator answers) kept its lingering fix claim counted as an in-flight fix,
 * so the fix dispatcher's scope-overlap serialization refused every other PR on the same file behind it.
 *
 * LIVE INCIDENT: web-everything/web-everything PR #3834 stood down at 23:02Z; nobody was working it, yet the
 * daemon logged "refused scope-overlap … PR #3787 — we:AGENTS.md overlaps in-flight fix PR #3834 — waiting 2nd
 * behind #3834", which also froze #3771 and #3767 behind #3787.
 *
 * FIX: `reconcile-fix-dispatch.mjs#dropTerminalFixClaims` — a PR reconcile refuses `stood-down` (unanswered) holds
 * no scope slot. Answered and re-dispatched, it re-enters normally.
 *
 * SCENARIO (fix-dispatch daemon only): PR A carries an unanswered stand-down plus a lingering live fix claim on
 * `soak/shared.txt`; PR B (review:changes + finding) edits the SAME file.
 * JUDGE: B is owed a fix; pre-fix it is refused scope-overlap behind A forever (`owed` violation), post-fix it
 * is dispatched.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSoak } from '../soak.mjs';
import { acquireFixDispatchClaim } from '../../fix-dispatch-claim.mjs';
import { fixDispatchClaimRoot } from '../../fix-claim-store.mjs';
import { resolveCoordinationRoot } from '../../../operations/coordination-root.mjs';
import { CONSTELLATION_REPOS } from '../../../lib/constellation-repos.mjs';
import { buildStandDownComment } from '../../stand-down.mjs';

const FILE = 'soak/shared.txt';

export default {
  id: 'standdown-pr-holds-scope-slot',
  title: 'a stood-down PR (terminal until a human answers) keeps holding its scope slot and blocks other PRs on the same file',
  card: 'operator 2026-10-03; live #3834 blocking #3787/#3771/#3767',
  fixedBy: { sha: '282ee6a9b', where: 'lane/fix-standdown-holds', paths: ['scripts/conveyor/reconcile-fix-dispatch.mjs'] },
  fixPresent(root) {
    try {
      return /dropTerminalFixClaims/.test(readFileSync(join(root, 'scripts/conveyor/reconcile-fix-dispatch.mjs'), 'utf8'));
    } catch { return false; }
  },
  run({ log } = {}) {
    return runSoak({
      name: 'break:standdown-pr-holds-scope-slot', rounds: 10,
      daemons: ['fix-dispatch'], mainEvery: 0, fleet: false, scorecards: false,
      setup(w, { api }) {
        w.git.createBranch('we', 'lane/soak-standdown-a', { from: 'main', files: { [FILE]: 'written by A\n' } });
        const a = w.gh.openPr({ repo: 'we', head: 'lane/soak-standdown-a', title: 'soak: stands down', labels: ['review:changes'], body: 'No backlog item.' });
        w.gh.setChecks('we', a, [{ name: 'test', conclusion: 'SUCCESS' }]);
        w.gh.comment('we', a, '1. soak finding on A', { author: 'review-bot' });
        // A's fix agent stood down: unanswered, terminal. Its fix claim lingers (session gone from the listing, so
        // the claim keeps its TTL grace) exactly like live #3834's did.
        w.gh.comment('we', a, buildStandDownComment({ reason: 'needs-judgment' }), { author: 'web-everything' });
        const lockRoot = fixDispatchClaimRoot(resolveCoordinationRoot({ env: w.env, home: w.env.HOME }));
        const hold = () => acquireFixDispatchClaim({
          repo: CONSTELLATION_REPOS.we.slug, pr: a, scope: [`we:${FILE}`], owner: 'soak-host:1', leaseMinutes: 100000,
          nowMs: w.clock.now(), lockRoot,
        });
        const claim = hold();
        api.say(`setup: stood-down PR #${a} holds a lingering fix claim (${claim.ok ? 'acquired' : claim.reason})`);
        return { a, b: null, hold };
      },
      perRound(w, round, ctx, api) {
        ctx.hold(); // keep the stood-down PR's claim fresh each round (the sim clock jumps 3m per tick; the live one lingered for hours)
        if (round !== 1) return; // not round 0: right after setup the world is still settling and a scratch clone of origin can read a half-written object store
        // B edits the SAME file as A and is owed a fix.
        w.git.createBranch('we', 'lane/soak-standdown-b', { from: 'main', files: { [FILE]: 'written by B\n' } });
        ctx.b = w.gh.openPr({ repo: 'we', head: 'lane/soak-standdown-b', title: 'soak: blocked behind the stood-down PR', labels: ['review:changes'], body: 'No backlog item.' });
        w.gh.setChecks('we', ctx.b, [{ name: 'test', conclusion: 'SUCCESS' }]);
        w.gh.comment('we', ctx.b, '1. soak finding on B', { author: 'review-bot' });
        api.owe(ctx.b, 'fix', `B (#${ctx.b}) must be dispatched even though stood-down A (#${ctx.a}) shares ${FILE}`);
      },
      log,
    });
  },
  judge(report) {
    return [...(report.fatal ? [report.fatal] : []), ...report.violations
      .filter((v) => ['owed', 'crash', 'isolation'].includes(v.invariant))
      .map((v) => `${v.daemon ?? '-'} tick ${v.tick ?? '-'}: [${v.invariant}] ${v.detail}`)];
  },
};
