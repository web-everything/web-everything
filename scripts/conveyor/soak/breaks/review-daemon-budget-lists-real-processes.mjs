/** Hermetic tests built the review pass's live-round budget from the host's REAL `ps` listing, so any live process
 * running from a lane checkout made them stat live lane paths and fail. The seam is `cliReviewTickOpts({ listCommands })`. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DAEMON = 'skills-src/conveyor/review-daemon.mjs';

export default {
  id: 'review-daemon-budget-lists-real-processes',
  title: 'the review pass builds its live-round budget from the real process list, ignoring an injected one',
  card: 'main-fix: lane-pool hermetic live-access failures (review-tick-promote, review-daemon verify-admission)',
  fixedBy: { sha: '75e658a87c31f3b7a2dc976bb0604108f476d3a0', where: 'lane/main-fix-lane-pool-hermetic', paths: [DAEMON] },
  fixPresent(root) {
    return readFileSync(join(root, DAEMON), 'utf8').includes('listCommands ? { listCommands } : {}');
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const { cliReviewTickOpts } = await import(pathToFileURL(join(root, DAEMON)).href);
    let calls = 0;
    cliReviewTickOpts({ log: { error: () => {} }, listCommands: () => { calls++; return ''; } });
    return { violations: calls === 0 ? ['an injected listCommands was never used; the real process list was read'] : [] };
  },
  judge(report) { return report.violations; },
};
