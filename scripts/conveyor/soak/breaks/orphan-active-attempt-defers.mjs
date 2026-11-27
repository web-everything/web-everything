/** Concurrent orphan passes must not park a PR while its first dispatch is in flight. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ghRepoSlug } from '../../../lib/constellation-repos.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

export function probe(checkout) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { strictEqual, deepStrictEqual, match } from 'node:assert';
    import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const [checkout, repo] = process.argv.slice(1);
    const { runOrphanFixRoundPass } = await import(
      pathToFileURL(join(checkout, 'scripts/conveyor/orphan-fix-round.mjs')));
    const { acquireLockDir, lockDirFor } = await import(
      pathToFileURL(join(checkout, 'scripts/readiness/file-locks.mjs')));
    const attemptRoot = mkdtempSync(join(tmpdir(), 'orphan-concurrent-soak-'));
    try {
      const stamp = (createdAt, body) => ({ createdAt, body,
        includesCreatedEdit: false, author: { login: 'web-everything' } });
      const comments = [stamp('2026-10-10T10:00:00Z', '🔁 review — changes requested'),
        stamp('2026-10-10T11:00:00Z', '🔓 conveyor fix-end — fix claim released')];
      let dispatches = 0, escalations = 0, markers = 0, release;
      let started;
      const inFlight = new Promise(resolve => { started = resolve; });
      const options = { attemptRoot, env: {}, nowMs: Date.parse('2026-10-10T12:00:00Z'),
        repos: [{ key: 'we', slug: repo }],
        listBounced: () => [{ number: 1, labels: ['review:changes'],
          headRefOid: 'a'.repeat(40), isDraft: false }],
        readComments: async () => comments, isOwned: async () => false,
        resolveProfile: () => ({ capabilities: { fix: true } }),
        redispatch: async () => {
          dispatches += 1;
          return new Promise(resolve => { release = resolve; started(); });
        },
        escalate: async () => { escalations += 1; return { ok: true }; },
        postComment: async () => { markers += 1; throw new Error('marker unavailable'); },
      };
      const first = runOrphanFixRoundPass(options);
      await Promise.race([inFlight, first.then(report => {
        throw new Error('first pass did not dispatch: ' + JSON.stringify(report));
      })]);
      const second = await runOrphanFixRoundPass(options);
      release({ ok: true });
      await first;
      strictEqual(dispatches, 1, 'only the claim holder may dispatch');
      strictEqual(escalations, 0, 'a concurrent pass must not park the PR for a human');
      strictEqual(markers, 1, 'the busy pass must not publish an escalation marker');
      strictEqual(second.rows[0]?.decision, 'defer');
      deepStrictEqual(second.nextCursor, { repo, pr: 1 });
      options.redispatch = async () => { dispatches += 1; return { ok: true }; };
      await runOrphanFixRoundPass({ ...options, cursor: second.nextCursor });
      strictEqual(dispatches, 2, 'the deferred PR must remain eligible after release');
      // Identical legacy comments replayed as fresh objects cannot create a new budget.
      options.readComments = async () => comments.map(comment => ({ ...comment }));
      const exhausted = await runOrphanFixRoundPass({ ...options, nowMs: options.nowMs + 60_000 });
      strictEqual(dispatches, 2, 'ID-less replay must retain the two-attempt cap when marker posts fail');
      strictEqual(escalations, 1);
      strictEqual(exhausted.rows[0]?.decision, 'escalate');
      const ledgers = readdirSync(attemptRoot).filter(name => name.endsWith('.json'));
      strictEqual(ledgers.length, 1, 'all identical ID-less verdicts must share one ledger');
      const ledger = JSON.parse(readFileSync(join(attemptRoot, ledgers[0]), 'utf8'));
      strictEqual(ledger.confirmed, 2);
      strictEqual(ledger.pending, false);
      const abandonedRoot = join(attemptRoot, 'abandoned');
      const entry = { owner: ledger.resource, path: ledger.resource, pid: null,
        heartbeatAt: '2000-01-01T00:00:00Z' };
      strictEqual(acquireLockDir(abandonedRoot, ledger.resource, entry), true);
      const held = await runOrphanFixRoundPass({ ...options, attemptRoot: abandonedRoot,
        nowMs: options.nowMs + 365 * 24 * 60 * 60_000 });
      strictEqual(dispatches, 2, 'an abandoned claim without a ledger must launch nothing');
      match(held.rows[0]?.result, /ambiguous attempt claim.*human inspection/);
      deepStrictEqual(JSON.parse(readFileSync(join(lockDirFor(abandonedRoot, ledger.resource), 'lock.json'), 'utf8')),
        entry, 'aged abandoned claims must remain untouched');
    } finally {
      rmSync(attemptRoot, { recursive: true, force: true });
    }
  `, checkout, ghRepoSlug('we')], { encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024 });
  return { violations: child.status === 0 ? [] : [
    `concurrent orphan replay failed: ${child.error?.message ?? child.stderr ?? child.signal ?? child.status}`,
  ] };
}

export default {
  id: 'orphan-active-attempt-defers',
  title: 'active orphan attempts defer concurrent passes without human escalation',
  card: 'PR #7551 concurrent orphan attempt',
  fixedBy: { sha: 'pending', where: 'HEAD', paths: ['scripts/conveyor/orphan-fix-round.mjs'] },
  fixPresent: checkout => probe(checkout).violations.length === 0,
  run: () => probe(root),
  judge: report => report.violations,
};
