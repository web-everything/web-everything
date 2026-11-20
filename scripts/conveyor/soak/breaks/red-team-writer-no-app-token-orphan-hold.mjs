/**
 * 2026-11-19 13:43-13:50 ET: operator-shell red-team round runs (no WE App token) fell back to personal credentials,
 * which can post statuses but cannot create check runs, so each run added an orphan `red-team/publication` hold
 * (#6945/#7149/#7156). The round writer must refuse BEFORE posting any hold when the App token does not resolve.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = 'example-org/example-repo';
const HEAD = 'c'.repeat(40);

export default {
  id: 'red-team-writer-no-app-token-orphan-hold',
  title: 'The red-team round writer posts a publication hold even when no WE App token resolves, orphaning a hold no check run can ever clear',
  card: 'rt-writer-failclosed (operator-shell orphan holds on #6945/#7149/#7156)',
  fixedBy: { sha: '0000000000000000000000000000000000000000', where: 'lane/rt-writer-failclosed', paths: ['scripts/lib/red-team-check-run.mjs', 'scripts/lib/drain-red-team-evidence.mjs'] },
  fixPresent(root) {
    // Harness callers require a synchronous boolean. Importing the writer here starts its dependency graph
    // before run() imports the publisher, leaving Vitest's overlapping cyclic imports waiting on each other.
    return readFileSync(join(root, 'scripts/lib/red-team-check-run.mjs'), 'utf8')
      .includes("WE_GH_AUTH_PERSONAL_FALLBACK: 'refuse'");
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const { recordRedTeamStatus } = await import(pathToFileURL(join(root, 'scripts/lib/drain-red-team-evidence.mjs')).href);
    const violations = [];
    const dir = mkdtempSync(join(tmpdir(), 'rt-writer-soak-'));
    try {
      const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs'), WE_DAEMON_EVENTS: join(dir, 'events.jsonl') };
      const loopPayload = { verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev: HEAD } } } };
      const posts = [];
      const options = { env, gh: () => '', log: () => {},
        appWriterProbe: () => { throw Error('REFUSING personal-auth fallback'); },
        postCheckRun: () => { posts.push('check'); return { ok: true }; },
        postPublicationHold: () => { posts.push('hold'); return { ok: true }; } };
      recordRedTeamStatus({ repo: REPO, pr: 6945, head: HEAD, loopPayload, status: 'running' }, options);
      if (posts.length) violations.push(`a round with no App token posted ${posts.join(',')} before refusing`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
    return { violations };
  },
  judge(report) { return report.violations; },
};
