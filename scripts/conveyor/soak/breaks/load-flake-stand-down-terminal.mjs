/**
 * Live #3881 (2026-10-04 14:51 ET): the fixer's repair was ready on an alt branch, but local verify was red only
 * on host-load timeouts. It posted a TERMINAL gate-red stand-down, so the planner refused the PR forever
 * ("terminal until an explicit operator answer"). Replay through the real planner: that stand-down is a
 * re-armable load-flake hold, never `stood-down`, and the re-verify planner picks it once the host is quiet.
 */
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BODY = [
  '🛑 conveyor fix — stood down, human judgment needed',
  '',
  'conveyor fix agent stopped rather than guessing: the gate stayed RED after the repair, and a red diff must never be re-pushed. fix ready on lane/fix-polluted-branch-scope-read-fix-3881-alt (9202eee8a); soak red-green PROVEN; verify red ONLY on docket-refresh.test.mjs 5s timeout (passes alone 24/24, load avg 25-36) = load flakiness for quarantine card 4999, per operator ruling not edited here.',
  '',
  '**A human is the intended next step.**',
  '<!-- stand-down reason=gate-red -->',
].join('\n');

export default {
  id: 'load-flake-stand-down-terminal',
  title: 'a stand-down blocked only on host-load-flaky verify re-arms for a quiet-host re-verify (#3881)',
  card: 'PR #3881',
  fixedBy: { sha: 'uncommitted', where: 'lane/load-flake-reverify', paths: ['scripts/conveyor/stand-down.mjs', 'scripts/conveyor/reconcile-core.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/conveyor/stand-down.mjs'), 'utf8').includes('export function loadFlakeHoldState');
  },
  async run({ sourceRoot } = {}) {
    const root = sourceRoot ?? resolve(fileURLToPath(import.meta.url), '../../../../..');
    const { countUnresolvedStandDowns } = await import(pathToFileURL(join(root, 'scripts/conveyor/reconcile-core.mjs')).href);
    const comment = { body: BODY, createdAt: '2026-10-04T18:51:50Z', author: { login: 'web-everything' } };
    const violations = [];
    if (countUnresolvedStandDowns([comment]) !== 0) violations.push('load-flake stand-down still terminal');
    const late = { ...comment, createdAt: '2026-10-06T00:00:00Z' };
    if (countUnresolvedStandDowns([late]) !== 1) violations.push('post-cutoff prose was sniffed');
    const plain = { ...comment, body: BODY.replace(/load flakiness/g, 'a real failure') };
    if (countUnresolvedStandDowns([plain]) !== 1) violations.push('ordinary gate-red no longer terminal');
    // PR #3945 review: the reverify pass sweeps only WE, so a legacy comment on another repo must stay terminal.
    const { CONSTELLATION_REPOS } = await import(pathToFileURL(join(root, 'scripts/lib/constellation-repos.mjs')).href);
    const elsewhere = { ...comment, url: `https://github.com/${CONSTELLATION_REPOS.frontierui.slug}/pull/12#issuecomment-1` };
    if (countUnresolvedStandDowns([elsewhere]) !== 1) violations.push('legacy load-flake stand-down on a repo nothing reverifies was parked silently');
    return { violations };
  },
  judge(report) { return report.violations; },
};
