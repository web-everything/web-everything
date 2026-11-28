/** REST and GraphQL expose different login shapes for the same trusted App author. */
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const b = {
  id: 'supersede-bot-author-shapes',
  title: 'a REST bot author and its GraphQL identity stand down the superseded PR despite large closed history and a lagging search index',
  card: 'PR 7559 bot author identity send-back',
  fixedBy: { sha: 'lane/supersede-watch-harden', where: 'working tree', paths: ['scripts/conveyor/supersede-watch.mjs'] },
  fixPresent(root) {
    const script = `import(${JSON.stringify(import.meta.url)}).then(m => m.probe(${JSON.stringify(root)})).then(ok => process.exit(ok ? 0 : 1), () => process.exit(1));`;
    return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024,
    }).status === 0;
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const { runSupersedeWatch, formatSupersedeLines } = await import(pathToFileURL(join(sourceRoot, 'scripts/conveyor/supersede-watch.mjs')).href);
    const { buildSupersededStandDownComment } = await import(pathToFileURL(join(sourceRoot, 'scripts/conveyor/stand-down.mjs')).href);
    const repo = ['fixture', 'project'].join('/');
    const source = { number: 20, id: 'PR_20', state: 'MERGED', body: 'Supersedes: #10',
      author: { login: 'web-everything' }, mergedAt: '2026-11-25T10:00:00Z',
      updatedAt: '2026-11-25T11:00:00Z', headRefOid: 'a'.repeat(40), lastEditedAt: null, editor: null };
    const target = { number: 10, id: 'PR_10', state: 'OPEN', headRefOid: 'b'.repeat(40), labels: [], comments: [] };
    let bodyReads = 0;
    let writes = 0;
    let closedPages = 0;
    const old = '2020-01-01T00:00:00Z';
    const history = Array.from({ length: 12000 }, (_, i) => ({ number: i + 100,
      state: 'closed', body: '', merged_at: old, updated_at: old, user: source.author }));
    const exec = (cmd, args) => {
      if (cmd !== 'gh' || args[0] !== 'api') throw new Error(`unexpected IO: ${cmd} ${args.join(' ')}`);
      if (args[1] === 'graphql') {
        if (args.some(a => a.includes('pullRequest(number:'))) {
          bodyReads += 1;
          return JSON.stringify({ data: { repository: { pullRequest: { ...source,
            author: { login: bodyReads % 2 ? 'web-everything' : 'web-everything[bot]' } } } } });
        }
        // GitHub search lags REST for hours: it has not indexed the merge yet, so it counts 0 where REST lists 1.
        if (args.some(a => a.startsWith('q='))) return JSON.stringify({ data: { search: { issueCount: 0 } } });
        return JSON.stringify({ data: { repository: { pullRequests: { totalCount: args.includes('s[]=OPEN') ? 1 : history.length + 1 } } } });
      }
      const url = new URL(args[1], 'https://fixture.invalid');
      const open = url.searchParams.get('state') === 'open';
      if (!open) closedPages += 1;
      const rows = open ? [{ number: 10 }] : [{ number: 20,
        body: source.body, merged_at: source.mergedAt, updated_at: source.updatedAt, user: { login: 'web-everything[bot]' } }, ...history];
      const page = Number(url.searchParams.get('page'));
      return JSON.stringify(rows.slice((page - 1) * 100, page * 100));
    };
    const tick = () => runSupersedeWatch({ repo, now: Date.parse('2026-11-26T12:00:00Z'),
      settings: { hold: true, lookbackDays: 14 }, exec, readPr: () => target,
      postHold: ({ hold }) => {
        writes += 1;
        target.comments.push({ author: { login: 'web-everything' }, body: buildSupersededStandDownComment(hold) });
        return { ok: true, labeled: true };
      } });
    const results = [tick(), tick()];
    const violations = [];
    if (results[0].holds.length !== 1 || results[0].holds[0].pr !== 10 || results[0].applied[0]?.ok !== true)
      violations.push('equivalent REST/GraphQL bot authors did not stand down PR 10');
    if (results.some(r => r.bodyEditFailures || r.blocked)) violations.push('trusted bot evidence was rejected');
    if (writes !== 1 || results[1].holds.length !== 0) violations.push('retry did not observe the existing hold');
    if (closedPages > 6) violations.push('closed history exceeded three REST pages per tick');
    const lines = formatSupersedeLines({ repos: results });
    lines.forEach(line => log?.(line));
    return { violations, results, writes, bodyReads, closedPages, lines };
  },
  judge: report => report.violations,
};
export default b;
export async function probe(root) {
  return b.judge(await b.run({ sourceRoot: root })).length === 0;
}
