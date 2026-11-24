/**
 * frontierui #53/#54/#58 (2026-11-24): the drain has no sibling clone of frontierui, so its net diff is unverified,
 * and the "net diff unverified" hold re-added review:human + review:awaiting-advisory a few minutes after every
 * `--to=clear-human`, whatever the recorded clearance said. A clearance recorded on the EXACT live head must honour
 * that hold; a new head, an older clearance, or a real tamper finding must keep it.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const H = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const unverified = [{ kind: 'test-diff-unverified', path: '(net diff)', detail: 'no-clone' }];

/** Decide in a child node process so a missing export on an unfixed tree is a plain `undefined`, synchronously. */
function decide(root, input) {
  const url = pathToFileURL(join(root, 'scripts/lib/review-escalation.mjs')).href;
  const code = `const m = await import(${JSON.stringify(url)}); const f = m.shouldReparkForUnverifiedDiff;`
    + ` process.stdout.write(typeof f === 'function' ? String(f(${JSON.stringify(input)})) : 'undefined');`;
  return execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

export default {
  id: 'unverified-diff-ignores-human-clearance',
  title: 'frontierui #53: a recorded clear-human on the live head does not stop the drain re-adding review:human for an unverified net diff',
  card: 'CLEAR-HUMAN-NOT-STICKY (unverified-diff hold honours the recorded head clearance)',
  fixedBy: { sha: '0000000000000000000000000000000000000000', where: 'lane/clear-human-not-sticky', paths: ['scripts/lib/review-escalation.mjs', 'scripts/merge-ai-prs.mjs'] },
  fixPresent(root) { return decide(root, { unverified: true, findings: unverified, humanClearedSha: H, headSha: H, pinnedHeadSha: H }) === 'false'; },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const violations = [];
    const base = { unverified: true, findings: unverified, humanClearedSha: H, headSha: H, pinnedHeadSha: H };
    if (decide(root, base) !== 'false') violations.push('a clearance on the exact live head still re-parks review:human');
    for (const [name, over] of [['an older clearance', { humanClearedSha: OLD }], ['a moved head', { pinnedHeadSha: OLD }],
      ['no clearance', { humanClearedSha: null }], ['a real tamper finding', { findings: [...unverified, { kind: 'tests-removed' }] }]]) {
      if (decide(root, { ...base, ...over }) !== 'true') violations.push(`${name} no longer keeps the hold`);
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
