/** Stable orphan-guard verdicts must drain a bounded pass instead of wrapping into holds forever. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ghRepoSlug } from '../../../lib/constellation-repos.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

export function probe(checkout) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { deepStrictEqual, strictEqual, ok } from 'node:assert';
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const [checkout, repo] = process.argv.slice(1);
    const { runOrphanFixRoundPass } = await import(
      pathToFileURL(join(checkout, 'scripts/conveyor/orphan-fix-round.mjs')));
    const settled = new Map();
    const reads = [];
    const options = {
      repos: [{ key: 'we', slug: repo }], env: {}, settled,
      nowMs: Date.parse('2026-10-10T12:00:00Z'), now: () => 0, deadlineAt: 0,
      listBounced: () => [1, 2, 3, 4, 5].map(number => ({
        number, labels: ['review:changes'], headRefOid: 'a'.repeat(40), isDraft: false,
      })),
      readComments: async pr => { reads.push(pr); return [{
        createdAt: '2026-10-10T10:00:00Z', body: '🔁 review — changes requested',
        includesCreatedEdit: false, author: { login: 'web-everything' },
      }]; },
      isOwned: async () => false,
      redispatch: async () => { throw new Error('no fix round: ordinary dispatch owns it'); },
      rearm: async () => { throw new Error('unexpected rearm'); },
      escalate: async () => { throw new Error('unexpected escalation'); },
      postComment: () => { throw new Error('unexpected comment'); },
    };
    const first = await runOrphanFixRoundPass(options);
    strictEqual(first.handled, 1, 'tiny budget must handle one PR');
    strictEqual(first.deferred.length, 4);
    const second = await runOrphanFixRoundPass({ ...options, cursor: first.repoCursors ?? first.nextCursor });
    ok(second.deferred.length < first.deferred.length,
      'second pass must defer fewer PRs after stable verdicts settle');
    deepStrictEqual(reads, [1, 2], 'cached wrapped PR must not be read again');
    strictEqual(second.handled, 1, 'cached PR must not count as handled');
    deepStrictEqual(second.rows, [], 'stable no-fix verdicts must not act');
  `, checkout, ghRepoSlug('we')], { encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 });
  return { violations: child.status === 0 ? [] : [
    `settled orphan-guard replay failed: ${child.error?.message ?? child.stderr ?? child.signal ?? child.status}`,
  ] };
}

export default {
  id: 'orphan-guard-settles',
  title: 'orphan guard settles stable verdicts across bounded passes',
  card: 'fix-daemon orphan guard settlement',
  fixedBy: { sha: 'pending', where: 'HEAD', paths: [
    'scripts/conveyor/orphan-fix-round.mjs', 'skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs',
  ] },
  fixPresent: checkout => probe(checkout).violations.length === 0,
  run: () => probe(root),
  judge: report => report.violations,
};
