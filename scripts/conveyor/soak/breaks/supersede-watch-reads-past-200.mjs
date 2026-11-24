/** Both supersede-watch PR readers must reach rows beyond the old 200-row limit. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

// Run the supplied checkout for historical replay; the verdict uses only returned rows.
export function probe(checkout) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const { defaultReadMergedPrs, defaultReadOpenNumbers } = await import(
      pathToFileURL(join(process.argv[1], 'scripts/conveyor/supersede-watch.mjs')));
    const now = Date.parse('2026-06-15T12:00:00Z');
    const rows = Array.from({ length: 251 }, (_, index) => {
      const date = new Date(now - index * 60_000).toISOString();
      return { number: index + 1, body: 'Supersedes #777', state: 'MERGED',
        mergedAt: date, author: { login: 'soak-author' },
        merged_at: date, updated_at: date, user: { login: 'soak-author' } };
    });
    const makeExec = () => {
      let calls = 0;
      return (command, args) => {
        if (++calls > 10) throw new Error('probe call budget exceeded');
        if (command !== 'gh') throw new Error('unexpected executable');
        if (args[0] === 'api' && /^repos\\/[^/]+\\/[^/]+\\/pulls\\?/.test(args[1])) {
          const url = new URL('https://fixture.invalid/' + args[1]);
          const page = Number(url.searchParams.get('page'));
          const size = Number(url.searchParams.get('per_page'));
          if (!Number.isInteger(page) || page < 1 || !Number.isInteger(size) || size < 1 || size > 100) {
            throw new Error('unsupported pulls pagination');
          }
          return JSON.stringify(rows.slice((page - 1) * size, page * size));
        }
        if (args[0] === 'pr' && args[1] === 'list') {
          const limitAt = args.indexOf('--limit');
          const limit = Number(args[limitAt + 1]);
          if (limitAt < 0 || !Number.isInteger(limit) || limit < 1) throw new Error('missing list limit');
          return JSON.stringify(rows.slice(0, limit));
        }
        throw new Error('unexpected gh arguments: ' + JSON.stringify(args));
      };
    };
    const merged = await defaultReadMergedPrs({ repo: 'soak/repo', lookbackDays: 7, now, exec: makeExec() });
    const open = await defaultReadOpenNumbers({ repo: 'soak/repo', exec: makeExec() });
    // No planner/helper from the checkout participates in the verdict.
    if (!Array.isArray(merged) || !merged.some(row => row.number === 251)) {
      throw new Error('merged reader omitted old row #251');
    }
    if (!Array.isArray(open) || !open.includes(251)) throw new Error('open reader omitted old row #251');
  `, checkout], { encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 });
  return { violations: child.status === 0 ? [] : [
    `supersede-watch past-200 replay failed: ${child.error?.message || child.stderr || child.signal || child.status}`,
  ] };
}

export default {
  id: 'supersede-watch-reads-past-200',
  title: 'supersede-watch reads merged and open PRs beyond row 200',
  card: 'supersede-watch PR list pagination',
  fixedBy: { sha: 'HEAD', where: 'scripts/conveyor/supersede-watch.mjs', paths: ['scripts/conveyor/supersede-watch.mjs'] },
  fixPresent: checkout => probe(checkout).violations.length === 0,
  run: () => probe(root),
  judge: report => report.violations,
};
