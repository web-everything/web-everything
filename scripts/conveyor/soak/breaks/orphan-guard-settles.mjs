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
    const { runOrphanFixRoundPass, ORPHAN_GUARD_MARKER } = await import(
      pathToFileURL(join(checkout, 'scripts/conveyor/orphan-fix-round.mjs')));
    const { FIX_END_MARKER } = await import(pathToFileURL(join(checkout, 'scripts/conveyor/fix-procedure.mjs')));
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
    strictEqual(second.deferredSettled.length, 1, 'cached budget deferral must be separate');
    let cursor = second.repoCursors;
    for (let pass = 0; pass < 4; pass++) {
      const result = await runOrphanFixRoundPass({ ...options, cursor });
      cursor = result.repoCursors;
      if (pass >= 2) strictEqual(result.deferred.length, 0, 'uncached holds must drain to zero');
    }
    const live = { ...options, deadlineAt: Infinity,
      listBounced: () => options.listBounced().slice(0, 1) };
    const refreshed = await runOrphanFixRoundPass({ ...live, nowMs: options.nowMs + 1 });
    strictEqual(refreshed.handled, 1, 'cached PR must receive a live check');
    strictEqual(settled.get(repo + '#1').at, options.nowMs + 1, 'visit must refresh cache age');
    const unreadable = await runOrphanFixRoundPass({ ...live,
      readComments: async () => { throw new Error('incomplete thread'); } });
    strictEqual(unreadable.rows[0]?.decision, 'error', 'cached unreadable thread must fail closed');
    await runOrphanFixRoundPass(live);
    let escalated = false;
    const stamp = body => ({ body, createdAt: '2026-10-10T11:00:00Z',
      includesCreatedEdit: false, author: { login: 'web-everything' } });
    const orphan = await runOrphanFixRoundPass({ ...live,
      readComments: async pr => [...await options.readComments(pr),
        stamp(ORPHAN_GUARD_MARKER + ' — re-dispatched a fixer'),
        stamp(ORPHAN_GUARD_MARKER + ' — re-dispatched a fixer'), stamp(FIX_END_MARKER)],
      escalate: async () => { escalated = true; return { ok: true }; }, postComment: () => {} });
    strictEqual(orphan.rows[0]?.decision, 'escalate', 'later same-head orphan must be detected');
    ok(escalated, 'cached orphan must escalate');
    ok(!settled.has(repo + '#1'), 'live orphan must invalidate settlement');
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
