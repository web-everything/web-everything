/** Read-only replay: label age survives unrelated PR activity and unknown evidence never clears it. */
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const PATH = 'scripts/conveyor/health-smells/red-team-pending-overdue.mjs';
export default {
  id: 'red-team-pending-overdue',
  title: 'pending age follows label additions and unknown evidence preserves the alert',
  card: 'REDTEAM-STUCK-PENDING',
  fixedBy: { sha: 'working-tree', where: 'current tree', paths: [PATH] },
  fixPresent(root) {
    // Separate capability probe, deliberately with NO pending PR. Never use the replay's verdict to
    // select it.fails: regressions in age, threshold or unknown evidence must still be required passes.
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import smell from ${JSON.stringify(pathToFileURL(join(root, PATH)).href)};
      const result = smell.evaluate({ prs: [] }, { now: 0, config: { drain: { redTeamPendingMaxMin: 10 } } });
      process.exit(smell.id === 'red-team-pending-overdue' && Array.isArray(result) && result.length === 0 ? 0 : 1);
    `], { timeout: 15000, maxBuffer: 65536, encoding: 'utf8', env: { ...process.env, WE_UNDER_TEST: '1' } });
    return !probe.error && probe.status === 0;
  },
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
    } catch (error) { violations.push(`scenario failed: ${error.stack ?? error}`); }
    return { violations };
  },
  judge: report => report.violations,
};
