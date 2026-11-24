/**
 * @file breaks/orphan-guard-lists-past-200.mjs — ORPHAN-GUARD-CAP. The orphan guard listed open PRs with a fixed
 * `gh pr list --limit 200` and never paged, so a `review:changes` PR beyond the 200 newest was never seen and
 * never re-armed.
 *
 * Fix: `defaultListBounced` pages the open-PR list (newest first, 100 per page, capped at 5 pages per
 * pass) so a bounced PR at position 201 is returned. Every pass starts at page one.
 *
 * SCENARIO: a fake `gh` returning 3 pages (100, 100, 1 PR); the lone PR on page 3 (position 201) carries
 * `review:changes`. Pre-fix the single capped call never reaches it.
 */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const PROBE = 'const { defaultListBounced } = await import(process.argv[1]);'
  + 'const seen = []; try { defaultListBounced("o/r", { exec: (...a) => { seen.push(a[1]); return "[]"; } }); } catch {}'
  + 'console.log(JSON.stringify(seen));';

function pr(number, bounced) {
  return { number, labels: bounced ? [{ name: 'review:changes' }] : [], head: { sha: `h${number}` }, draft: false, body: '', created_at: '2026-01-01T00:00:00Z' };
}

export default {
  id: 'orphan-guard-lists-past-200',
  title: 'the orphan guard listed only the 200 newest open PRs, so a review:changes PR past position 200 was never re-armed',
  card: 'we:backlog/orphan-guard-cap.md',
  fixedBy: { sha: 'HEAD', where: 'lane/orphan-guard-cap', paths: ['scripts/conveyor/orphan-fix-round.mjs'] },
  // Decided by a separate one-call probe (not the 3-page scenario below): the fixed lister asks `gh api`, the old one `gh pr list`.
  fixPresent(root) {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE, pathToFileURL(join(root, 'scripts/conveyor/orphan-fix-round.mjs')).href], { encoding: 'utf8' });
    try { return JSON.parse(r.stdout.trim().split('\n').pop())[0]?.[0] === 'api'; } catch { return false; }
  },
  async run({ root, log } = {}) {
    const { defaultListBounced } = await import(pathToFileURL(join(root ?? process.cwd(), 'scripts/conveyor/orphan-fix-round.mjs')).href);
    const pages = [Array.from({ length: 100 }, (_, i) => pr(i + 1, false)), Array.from({ length: 100 }, (_, i) => pr(101 + i, false)), [pr(201, true)]];
    let call = 0;
    const queries = [];
    const exec = (_cmd, args) => {
      call += 1;
      queries.push(String(args[1]));
      if (args[0] === 'pr') return JSON.stringify([...pages[0], ...pages[1]].map((p) => ({ number: p.number, labels: p.labels, headRefOid: p.head.sha, isDraft: false })));
      const m = /[&?]page=(\d+)/.exec(String(args[1]));
      return JSON.stringify(pages[Number(m?.[1] ?? 1) - 1] ?? []);
    };
    const got = defaultListBounced('o/r', { exec }).map((p) => p.number);
    log?.(`calls=${call} bounced=${got.join(',')}`);
    const violations = got.includes(201) ? [] : [{ invariant: 'bounced-pr-past-200-listed', detail: `PR #201 (review:changes) was not listed; got [${got.join(', ')}]` }];
    if (call !== 3) violations.push({ invariant: 'three-pages', detail: `expected 3 calls, got ${call}` });
    if (queries.some(query => !query.includes('sort=created&direction=desc&per_page=100'))) {
      violations.push({ invariant: 'newest-first', detail: 'listing must request newest PRs first' });
    }
    return { violations, got };
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
