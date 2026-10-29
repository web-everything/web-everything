/** PR #5983 review: one PR's failed complete-comment read aborted delegated clearance for every unrelated candidate. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const head = 'a'.repeat(40), prior = 'b'.repeat(40);
const bot = body => ({ author: { login: 'web-everything' }, body });
const held = number => ({ number, headRefOid: head, mergeable: 'MERGEABLE',
  labels: ['review:human', 'advisory:accepted', 'red-team:clear'],
  statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  comments: [bot('**Verdict:** human review required\n**Advisory outcome:** `accept`\n'
    + `Net basis: \`${prior}..${head}\``),
  bot(`<!-- we:red-team-advisory pr=${number} rev=${head} -->\nNo confirmed breaks.`)],
});

export default {
  id: 'delegated-comment-read-isolation',
  title: 'a failed complete-comment read for one PR aborted delegated clearance for every other candidate',
  card: 'PR #5983 review (scripts/conveyor/delegated-clearance-sweep.mjs:242, ruled block)',
  fixedBy: { sha: 'pending', where: 'lane/r130-delegated-sweep', paths: ['scripts/conveyor/delegated-clearance-sweep.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/conveyor/delegated-clearance-sweep.mjs'), 'utf8')
      .includes("One PR's failed thread read refuses only that PR");
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const { sweepDelegatedClearance } = await import(pathToFileURL(join(sourceRoot, 'scripts/conveyor/delegated-clearance-sweep.mjs')).href);
    const prs = [held(1), held(2), held(3)];
    // PR 2 has a long thread, so the sweep must read it completely; that read fails (rate limit, network).
    const listed = prs.map(p => (p.number === 2 ? { ...p, comments: Array(100).fill(p.comments[0]) } : p));
    let state = { observed: {}, memo: {} };
    const cleared = [];
    const violations = [];
    const results = sweepDelegatedClearance({ prs: listed, repo: 'o/r', setting: { shadowUntil: '2026-10-25T00:00:00Z' },
      now: () => Date.parse('2026-10-26T00:00:00Z'), readState: () => state,
      writeState: next => { state = structuredClone(next); },
      readNetFiles: ({ num }) => [`scripts/pr-${num}.mjs`],
      shape: () => ({ humanRequired: false }), readPreApprovals: () => [], readMovedFiles: () => [],
      readComments: number => {
        if (number === 2) throw new Error('gh api: rate limited');
        return prs.find(p => p.number === number).comments;
      },
      readPr: ({ number }) => prs.find(p => p.number === number),
      emit: () => {}, runLabel: ({ num }) => { cleared.push(num); return { ok: true }; } });
    if (JSON.stringify(cleared.sort()) !== JSON.stringify([1, 3])) violations.push(`unrelated candidates cleared: [${cleared.join(',')}], expected [1,3]`);
    if (!results.some(r => r.num === 2 && r.delegated === 'sweep-failed')) violations.push('the PR whose read failed was not reported as refused');
    log?.(`delegated comment read isolation: ${violations.length} violation(s)`);
    return { violations };
  },
  judge(report) { return report.violations; },
};
