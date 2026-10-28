/** PR #5983 red-team: one oversized candidate ended the delegated sweep and starved every later candidate. */
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
  id: 'delegated-oversized-candidate-starvation',
  title: 'an oversized delegated-clearance candidate starved the valid candidates behind it',
  card: 'PR #5983 red-team eabb48bcd6c52d65 (per-candidate failure isolation)',
  fixedBy: { sha: 'pending', where: 'lane/r130-delegated-sweep', paths: ['scripts/conveyor/delegated-clearance-sweep.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/conveyor/delegated-clearance-sweep.mjs'), 'utf8')
      .includes("One candidate's unreadable or oversized evidence refuses only that candidate");
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const { sweepDelegatedClearance } = await import(pathToFileURL(join(sourceRoot, 'scripts/conveyor/delegated-clearance-sweep.mjs')).href);
    const prs = [held(1), held(2), held(3)];
    let state = { observed: {}, memo: {} };
    const cleared = [];
    const violations = [];
    // Two ticks: the cursor wraps to 0 when the batch covers every candidate, so the starvation repeats each tick.
    for (let tick = 1; tick <= 2; tick++) {
      sweepDelegatedClearance({ prs, repo: 'o/r', setting: { shadowUntil: '2026-10-25T00:00:00Z' },
        now: () => Date.parse('2026-10-26T00:00:00Z'), readState: () => state,
        writeState: next => { state = structuredClone(next); },
        readNetFiles: ({ num }) => (num === 1 ? Array(1001).fill('x') : [`scripts/pr-${num}.mjs`]),
        shape: () => ({ humanRequired: false }), readPreApprovals: () => [], readMovedFiles: () => [],
        readComments: number => prs.find(p => p.number === number).comments,
        readPr: ({ number }) => prs.find(p => p.number === number),
        emit: () => {}, runLabel: ({ num }) => { cleared.push(num); return { ok: true }; } });
    }
    if (JSON.stringify(cleared) !== JSON.stringify([2, 3])) violations.push(`valid candidates cleared: [${cleared.join(',')}], expected [2,3]`);
    log?.(`delegated oversized candidate starvation: ${violations.length} violation(s)`);
    return { violations };
  },
  judge(report) { return report.violations; },
};
