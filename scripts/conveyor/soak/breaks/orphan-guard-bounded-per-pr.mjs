/** The orphan guard must bound redispatch work and resume deferred PRs between passes. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ghRepoSlug } from '../../../lib/constellation-repos.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

// Replay the supplied checkout behaviorally, including historical checkouts without the bounds.
export function probe(checkout) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { deepStrictEqual, strictEqual, ok } from 'node:assert';
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const [checkout, repo] = process.argv.slice(1);
    const { runOrphanFixRoundPass } = await import(
      pathToFileURL(join(checkout, 'scripts/conveyor/orphan-fix-round.mjs')));
    const comment = (createdAt, body) => ({
      createdAt, body, includesCreatedEdit: false, author: { login: 'web-everything' },
    });
    const comments = [
      comment('2026-10-10T10:00:00Z', '🔁 review — changes requested'),
      comment('2026-10-10T11:00:00Z', '🔓 conveyor fix-end — fix claim released'),
    ];
    const prs = [3, 1, 2].map(number => ({
      number, labels: ['review:changes'], headRefOid: 'a'.repeat(40), isDraft: false,
    }));
    const at = pr => ({ repo, pr });
    const fixture = ({ deadlineAt = Infinity, advance = 0, noFix = false } = {}) => {
      let time = 0;
      const calls = [], reads = [];
      const reconcile = () => { throw new Error('injected redispatch must not run a planner'); };
      return { calls, reads, options: {
        repos: [{ key: 'we', slug: repo }], env: {},
        nowMs: Date.parse('2026-10-10T12:00:00Z'), now: () => time, deadlineAt, reconcile,
        listBounced: () => prs,
        readComments: async pr => {
          reads.push(pr);
          if (noFix) { time += advance; return []; }
          return comments;
        },
        isOwned: async () => false,
        resolveProfile: () => ({ capabilities: { fix: true } }),
        redispatch: async options => {
          strictEqual(options.reconcile, reconcile, 'redispatch must receive the injected reconcile');
          calls.push(options.pr);
          time += advance;
          return { ok: true };
        },
        rearm: async () => { throw new Error('unexpected rearm'); },
        escalate: async () => { throw new Error('unexpected escalation'); },
        postComment: () => {},
      } };
    };
    const assertPass = (report, pr) => {
      ok(Number.isInteger(report.handled) && report.handled >= 1, 'pass must report progress');
      deepStrictEqual(report.rows.map(row => [row.pr, row.decision, row.result]),
        [[pr, 'redispatch', 're-dispatched']], 'exactly one successful redispatch per pass');
      ok(Array.isArray(report.deferred) && report.deferred.length > 0, 'remaining PRs must be deferred');
      deepStrictEqual(report.nextCursor, report.deferred[0], 'cursor must identify the first deferred PR');
    };

    // A roomy deadline isolates the one-redispatch cap from the time bound.
    const capped = fixture();
    const first = await runOrphanFixRoundPass(capped.options);
    deepStrictEqual(capped.calls, [1], 'at most one redispatch call in a pass');
    assertPass(first, 1);
    deepStrictEqual(first.deferred, [at(2), at(3)]);
    const second = await runOrphanFixRoundPass({ ...capped.options, cursor: first.nextCursor });
    deepStrictEqual(capped.calls, [1, 2], 'second pass must continue at the deferred PR');
    assertPass(second, 2);
    deepStrictEqual(second.deferred, [at(3)]);

    // No redispatch is planned here, so only the deadline can stop the next PR read.
    const idle = fixture({ deadlineAt: 10, advance: 10, noFix: true });
    const idleExpired = await runOrphanFixRoundPass(idle.options);
    deepStrictEqual(idle.reads, [1], 'deadline must prevent another non-redispatch PR read');
    deepStrictEqual(idle.calls, [], 'deadline fixture must not spend the redispatch cap');
    deepStrictEqual(idleExpired.rows, []);
    strictEqual(idleExpired.handled, 1);
    deepStrictEqual(idleExpired.deferred, [at(2), at(3)]);
    deepStrictEqual(idleExpired.nextCursor, at(2));

    // Spending the deadline on PR 1 must stop before even reading PR 2.
    const timed = fixture({ deadlineAt: 10, advance: 10 });
    const expired = await runOrphanFixRoundPass(timed.options);
    assertPass(expired, 1);
    strictEqual(expired.handled, 1, 'deadline must stop between PRs');
    deepStrictEqual(timed.reads, [1], 'deadline must prevent another PR read');
    deepStrictEqual(expired.deferred, [at(2), at(3)]);
    // The next pass starts already expired, but must still make one PR of progress.
    const resumed = await runOrphanFixRoundPass({ ...timed.options, cursor: expired.nextCursor });
    assertPass(resumed, 2);
    strictEqual(resumed.handled, 1, 'expired pass must still handle one PR');
    deepStrictEqual(timed.calls, [1, 2]);
    deepStrictEqual(timed.reads, [1, 2]);
    deepStrictEqual(resumed.deferred, [at(3)]);
  `, checkout, ghRepoSlug('we')], { encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 });
  return { violations: child.status === 0 ? [] : [
    `bounded orphan-guard replay failed: ${child.error?.message ?? child.stderr ?? child.signal ?? child.status}`,
  ] };
}

export default {
  id: 'orphan-guard-bounded-per-pr',
  title: 'orphan guard bounds each pass and resumes deferred PRs',
  card: 'fix-daemon bounded orphan guard',
  fixedBy: { sha: '372926d43c', where: 'HEAD', paths: ['scripts/conveyor/orphan-fix-round.mjs'] },
  fixPresent: checkout => probe(checkout).violations.length === 0,
  run: () => probe(root),
  judge: report => report.violations,
};
