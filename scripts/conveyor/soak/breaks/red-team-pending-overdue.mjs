/** Read-only replay: label age survives unrelated PR activity and unknown evidence never clears it. */
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONSTELLATION_REPOS, DEFAULT_REPO_KEY } from '../../../lib/constellation-repos.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const PATH = 'scripts/conveyor/health-smells/red-team-pending-overdue.mjs';
export default {
  id: 'red-team-pending-overdue',
  title: 'pending age follows label additions and unknown evidence preserves the alert',
  card: 'REDTEAM-STUCK-PENDING',
  fixedBy: { sha: 'working-tree', where: 'current tree', paths: [PATH, 'scripts/conveyor/health-watch.mjs'] },
  // The smell ships in the same tree as this break, so there is no tree where its absence is a legitimate
  // expected-fail. A missing file, wrong id, broken import or broken behaviour must all fail visibly: a probe that
  // reads "wrong id" as "capability absent" would let a behavioural regression satisfy it.fails.
  fixPresent() { return true; },
  async run({ sourceRoot = ROOT } = {}) {
    const violations = [];
    try {
      const { default: smell } = await import(pathToFileURL(join(sourceRoot, PATH)).href);
      const { emptyHealthState, stepEpisodes } = await import(pathToFileURL(join(ROOT, 'scripts/conveyor/health-watch-core.mjs')).href);
      const now = Date.parse('2026-11-24T12:00:00Z');
      const pr = { repo: 'example/project', number: 1, headRefOid: 'abcdef123456',
        labels: [{ name: 'red-team:pending' }], redTeamPendingSince: new Date(now - 50 * 60000).toISOString(),
        updatedAt: new Date(now).toISOString(), redTeamPendingMaxMin: 20 };
      const evaluate = prs => smell.evaluate({ prs }, { now });
      if (evaluate([pr])[0]?.breach !== true) violations.push('old pending with recent PR activity did not alert at configured 2x');
      const recent = { ...pr, redTeamPendingSince: new Date(now - 5 * 60000).toISOString(),
        updatedAt: new Date(now - 1000 * 60000).toISOString() };
      if (evaluate([recent])[0]?.breach !== false) violations.push('old PR activity falsely aged a recent pending label');
      const opened = stepEpisodes(emptyHealthState(), [{ smell, results: evaluate([pr]) }], now).state;
      for (const prs of [[{ ...pr, labels: [], labelsValid: false }],
        // JSON transport drops array properties: absence must remain unknown even then.
        JSON.parse(JSON.stringify(Object.assign([], { inventoryComplete: false })))]) {
        const next = stepEpisodes(opened, [{ smell, results: evaluate(prs) }], now + 1);
        if (next.transitions.some(t => t.type === 'closed') || Object.keys(next.state.episodes).length !== 1)
          violations.push('unknown labels or partial inventory cleared the alert');
      }
      // Replay a promoted PR whose shared snapshot still says draft and lacks pending.
      // A fresh pending label must never borrow that cached draft status to close its episode.
      const { probePrs } = await import(pathToFileURL(join(sourceRoot, 'scripts/conveyor/health-watch.mjs')).href);
      const promoted = { ...pr, repo: CONSTELLATION_REPOS[DEFAULT_REPO_KEY].slug };
      const promotedOpened = stepEpisodes(emptyHealthState(), [{ smell, results: evaluate([promoted]) }], now).state;
      const rows = probePrs({ now, clock: () => now,
        drainOptions: { env: {}, tool: { redTeamPendingMaxMin: 20 }, platform: {} },
        openRedTeamPrs: [`${promoted.repo}#1`],
        readSnapshot: ({ repo }) => repo === promoted.repo
          ? [{ ...promoted, isDraft: true, labels: [{ name: 'review:pending' }] }] : [],
        exec: (_bin, args) => args[0] === 'api'
          ? JSON.stringify({ data: { repository: { pullRequest: { timelineItems: { nodes: [
            { createdAt: pr.redTeamPendingSince, label: { name: 'red-team:pending' } },
          ] } } } } })
          : JSON.stringify({ labels: pr.labels, isDraft: false }),
      });
      const promotedNext = stepEpisodes(promotedOpened, [{ smell, results: evaluate(rows) }], now + 1);
      if (rows[0]?.isDraft !== false || promotedNext.transitions.some(t => t.type === 'closed')
        || Object.keys(promotedNext.state.episodes).length !== 1)
        violations.push('fresh pending labels with cached draft status cleared the alert');
    } catch (error) { violations.push(`scenario failed: ${error.stack ?? error}`); }
    return { violations };
  },
  judge: report => report.violations,
};
