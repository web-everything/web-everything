/** plateau-app #229: fixed repo order starved a review for thousands of minutes. */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runReviewTickAllRepos } from '../../../../skills-src/conveyor/review-daemon.mjs';

const SOURCE = 'skills-src/conveyor/review-daemon.mjs';

// Inject only the per-repo work; ordering and the shared host budget belong to the real daemon.
// Both repos keep owing work, and the previous review completes before the next tick frees one seat.
function exercise(runAll) {
  const repos = ['fixture/first-repo', 'fixture/second-repo'];
  const ticks = [], violations = [];
  for (let i = 0; i < 2; i++) {
    let admissionCalls = 0;
    const visited = [];
    const result = runAll({
      repos,
      // Omit startIndex: the production default must advance on successive ticks.
      hostAdmission: () => { admissionCalls++; return { admitted: true, maxPerTick: 1 }; },
      log() {},
      tick({ repo, hostAdmission }) {
        visited.push(repo);
        const budget = hostAdmission();
        const dispatched = [];
        if (budget.admitted && budget.maxPerTick > 0) {
          budget.take(1);
          dispatched.push({ prNumber: repo === repos[1] ? 229 : 1 });
        }
        return { reviewsOwed: 1, dispatched, failed: [], refusals: 0 };
      },
    });
    ticks.push(result.dispatched);
    if (admissionCalls !== 1) violations.push(`tick ${i}: host admission was not shared`);
    if (visited.length !== 2 || new Set(visited).size !== 2) violations.push(`tick ${i}: both repos were not visited`);
    if (result.dispatched.length !== 1) violations.push(`tick ${i}: expected exactly one dispatch for the one free seat`);
    if (result.reviewsOwed !== 2 || result.failed.length || result.reconcileFailed.length) {
      violations.push(`tick ${i}: review work was lost or failed`);
    }
  }
  for (const repo of repos) {
    if (ticks.flat().filter(d => d.repo === repo).length !== 1) {
      violations.push(`${repo}: did not get exactly one dispatch over two ticks`);
    }
  }
  // Seat availability that repeats with the rotation (one free seat, then two ticks with none) must not let a
  // no-capacity tick spend a repo's turn: each of three repos owes work and must be served once in three seats.
  const three = ['fixture/a', 'fixture/b', 'fixture/c'];
  const served = [];
  for (const seats of [1, 0, 0, 1, 0, 0, 1, 0, 0]) {
    const result = runAll({
      repos: three,
      hostAdmission: () => ({ admitted: true, maxPerTick: seats }),
      log() {},
      tick({ repo, hostAdmission }) {
        const budget = hostAdmission();
        const dispatched = [];
        if (budget.admitted && budget.maxPerTick > 0) { budget.take(1); dispatched.push({ prNumber: 1 }); }
        return { reviewsOwed: 1, dispatched, failed: [], refusals: 0 };
      },
    });
    served.push(...result.dispatched.map(d => d.repo));
  }
  ticks.push(served.map(repo => ({ repo })));
  for (const repo of three) {
    if (served.filter(r => r === repo).length !== 1) violations.push(`${repo}: starved under repeating 1,0,0 seat availability`);
  }
  return { ticks, violations };
}

export default {
  id: 'review-seat-starved-by-repo-order',
  title: 'one shared review seat serves both repos over two ticks without repo-order starvation',
  card: 'plateau-app #229',
  fixedBy: { sha: 'HEAD', where: SOURCE, paths: [SOURCE] },
  fixPresent(root) {
    // Synchronous behavioral probe for defineBreakTest/knownUnfixed; import the supplied tree,
    // not a source marker or a locally reimplemented rotation algorithm. Missing evidence is false.
    const code = `
      const { runReviewTickAllRepos } = await import(${JSON.stringify(pathToFileURL(join(root, SOURCE)).href)});
      const report = (${exercise.toString()})(runReviewTickAllRepos);
      process.stdout.write(report.violations.length === 0 ? 'fair' : 'starved');
    `;
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return !probe.error && probe.status === 0 && probe.stdout === 'fair';
  },
  async run({ log } = {}) {
    const report = exercise(runReviewTickAllRepos);
    log?.(`review-seat-starved-by-repo-order: ${JSON.stringify(report.ticks)}`);
    return report;
  },
  judge(report) { return report.violations; },
};
