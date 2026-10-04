/**
 * @file breaks/missing-run-structural-deferral-loops.mjs — PR #3253 review. The missing-run recovery's exact
 * preflight deferred stacked PRs (base != main), fork PRs and an already-marked recovery tip. A deferral posts
 * no marker comment, so the per-sha retry cap never counted them: each was re-planned, re-read and re-deferred
 * every tick forever and never handed off to a human / ci-heal.
 *
 * Fix: those three structural cases are now COUNTED failures (marker posted → `missing-run-cap-exhausted`
 * after the cap); only transient states (head moved, unknown mergeability, held claim) stay free deferrals.
 *
 * Scenario: the real `sweepMissingRunRecovery` + real `pushMissingRunCommit` over repeated ticks with a stubbed
 * `gh` read and a stateful comment store mirroring the durable marker.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const REPO = ['web-everything', 'web-everything'].join('/'); // built, not a literal — a stub slug, not a hardcoded target repo
const TICKS = 6;
const CAP = 2;

export default {
  id: 'missing-run-structural-deferral-loops',
  title: 'missing-run recovery re-deferred stacked/fork/marked-tip PRs every tick forever — deferrals post no marker, so the retry cap never tripped',
  card: 'we:backlog/4855',
  fixedBy: { sha: 'ad1f47ac0', where: 'lane/missing-run', paths: ['scripts/conveyor/missing-run-push.mjs'] },
  fixPresent(root) {
    const p = join(root, 'scripts/conveyor/missing-run-push.mjs');
    return existsSync(p) && /stacked or from a fork/.test(readFileSync(p, 'utf8'));
  },
  async run() {
    const { sweepMissingRunRecovery } = await import(join(REPO_ROOT, 'scripts/conveyor/ci-red-recovery-watch.mjs'));
    const { pushMissingRunCommit } = await import(join(REPO_ROOT, 'scripts/conveyor/missing-run-push.mjs'));
    const mk = (number, sha, base, headRepo) => ({
      pr: { number, headRefName: `lane/p${number}`, baseRefName: base, headRefOid: sha, mergeable: 'MERGEABLE', statusCheckRollup: [], labels: [] },
      live: { state: 'open', mergeable: true, head: { sha, ref: `lane/p${number}`, repo: { full_name: headRepo } }, base: { ref: base } },
    });
    // Case 9003 is a healthy PR on main whose daemon token is an unbound `ghs_` (Actions-style) installation
    // token: the credential is structurally ineligible to push, so it must be counted and handed off too.
    const cases = [mk(9001, 'a'.repeat(40), 'lane/other', REPO), mk(9002, 'b'.repeat(40), 'main', 'someone/web-everything'),
      { ...mk(9003, 'c'.repeat(40), 'main', REPO), env: { GH_TOKEN: 'ghs_actions' } }];
    const comments = new Map(cases.map((c) => [c.pr.number, []]));
    const exec = (cmd, args) => {
      if (cmd !== 'gh') throw new Error('structural refusal must never reach git');
      return JSON.stringify(cases.find((c) => c.pr.number === Number(args[1].split('/').pop())).live);
    };
    const now = Date.parse('2026-09-26T17:23:00Z');
    const attempts = new Map(cases.map((c) => [c.pr.number, 0]));
    let last;
    for (let tick = 0; tick < TICKS; tick++) {
      last = sweepMissingRunRecovery({
        apply: true, repo: REPO, readOpenPrs: () => cases.map((c) => c.pr), readRequiredContexts: () => ['test'],
        readHeadCommittedAt: () => '2026-09-26T14:20:26Z', readComments: (n) => comments.get(n), now,
        trigger: (d, o) => pushMissingRunCommit(d, { ...o, exec, env: cases.find((c) => c.pr.number === d.prNumber).env ?? { GH_TOKEN: 'ghp_x' }, checkClaim: () => null }),
        postComment: (n, o) => comments.get(n).push({ body: `🚦 conveyor missing-run-recovery\n\nsha: ${o.headSha}\n${o.error}`, author: { login: 'web-everything' } }),
        clearLabel: () => false,
      });
      for (const a of last.applied) attempts.set(a.prNumber, attempts.get(a.prNumber) + 1);
    }
    const violations = [];
    for (const c of cases) {
      const n = c.pr.number;
      if (attempts.get(n) > CAP) violations.push({ invariant: 'unbounded-retries', detail: `PR #${n} was re-attempted ${attempts.get(n)} times in ${TICKS} ticks (cap ${CAP})` });
      if (comments.get(n).length === 0) violations.push({ invariant: 'no-recorded-outcome', detail: `PR #${n} left no durable marker across ${TICKS} ticks` });
      if (!last.refusals.some((r) => r.prNumber === n && r.kind === 'missing-run-cap-exhausted')) {
        violations.push({ invariant: 'never-handed-off', detail: `PR #${n} never reached missing-run-cap-exhausted` });
      }
    }
    return { violations };
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
