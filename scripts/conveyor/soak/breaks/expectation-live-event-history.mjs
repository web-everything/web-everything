/** PR #7190: cumulative real events must not blind the observe-only babysitter. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExpectationPass } from '../../pass-daemons/pr-expectation-pass.mjs';
import { resolveExpectationSettings } from '../../pass-daemons/pr-expectations.mjs';
import { runUpdateBranch } from '../../../operations/update-branch.mjs';

const sha = 'a'.repeat(40), before = 'b'.repeat(40);
const at = minute => new Date(Date.UTC(2026, 10, 19) + minute * 60000).toISOString();

export default {
  id: 'expectation-live-event-history',
  title: 'real update events and stale PR history blind live expectation observations',
  card: 'PR #7190',
  fixedBy: { sha: 'HEAD', where: 'lane/babysitter-s1', paths: [
    'scripts/conveyor/pass-daemons/pr-expectations.mjs',
    'scripts/conveyor/pass-daemons/pr-expectation-pass.mjs',
  ] },
  fixPresent(root) {
    // A behavior probe of the requested tree, independent of the scenario's judge.
    return execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { deriveActions } from './scripts/conveyor/pass-daemons/pr-expectations.mjs';
      process.stdout.write(String(Array.isArray(deriveActions([{ kind: 'update-branch', pr: 7,
        at: '2026-11-19T00:00:00Z', detail: { status: 'failed', afterHead: null } }]))));
    `], { cwd: root, encoding: 'utf8', timeout: 10_000 }).trim() === 'true';
  },
  async run({ log } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'expectation-history-'));
    try {
      const eventsFile = join(root, 'events.jsonl'), stateFile = join(root, 'state.json');
      const events = []; let reads = 0;
      await runUpdateBranch({ repo: 'example/widgets', pr: 7, reason: 'soak fixture' }, {
        actor: () => 'fixture', sleep: async () => {}, update: async () => 202,
        readPr: async () => ({ state: 'open', head: { sha: ++reads === 1 ? before : sha },
          base: { ref: 'main' }, mergeable: true, mergeable_state: 'behind' }),
        compare: async () => ({ behind_by: reads === 1 ? 1 : 0 }),
        append: async event => { events.push({ ...event, at: at(0) }); return true; },
      });
      events.push({ kind: 'worker-push', pr: 99, sha, at: at(0) });
      writeFileSync(eventsFile, events.map(e => JSON.stringify(e)).join('\n') + '\n');
      const settings = resolveExpectationSettings({ tool: JSON.parse(readFileSync(
        new URL('../../../settings/expectations.json', import.meta.url), 'utf8')) });
      const delivered = []; let terminal = false; let calls = 0;
      const opts = { repo: 'example/widgets', settings, stateFile, env: { WE_DAEMON_EVENTS: eventsFile },
        log() {}, emitEvent(event) { delivered.push(event); return true; }, gh(args) {
          calls++;
          if (args[0] !== 'api' || args.includes('-X') || args.includes('--method')) throw Error('unexpected write');
          if (args[1].includes('/pulls?')) return terminal ? [] : [{ number: 7, state: 'open' }];
          if (args[1] === 'graphql') return { data: { repository: { pullRequest: {
            number: 7, state: terminal ? 'MERGED' : 'OPEN', headRefOid: sha,
            headRef: terminal ? null : { target: { committedDate: at(-1) } },
            mergedAt: terminal ? at(20) : null, mergeStateStatus: 'CLEAN',
            labels: { nodes: [{ name: 'ready-to-merge' }], pageInfo: { hasNextPage: false } },
            mergeQueueEntry: { enqueuedAt: at(-0.5) },
          } } } };
          if (args[1].includes('/timeline?')) return [];
          if (args[1].includes('/check-runs?')) return { total_count: 0, check_runs: [] };
          if (args[1].endsWith('/pulls/7')) return { state: terminal ? 'closed' : 'open', head: { sha } };
          throw Error('unexpected read');
        } };
      const first = await runExpectationPass({ ...opts, now: at(0) });
      const missed = await runExpectationPass({ ...opts, now: at(16) });
      const restart = await runExpectationPass({ ...opts, now: at(17) });
      terminal = true;
      const retired = await runExpectationPass({ ...opts, now: at(21) });
      const beforeNext = calls;
      const next = await runExpectationPass({ ...opts, now: at(22) });
      const violations = [];
      if ([first, missed, restart, retired, next].some(r => r.incomplete)) violations.push('ordinary history made the pass incomplete');
      if (delivered.length !== 1 || delivered[0]?.detail.expectationId !== 'update-no-restart') violations.push('update miss missing, duplicated, or spurious enqueue miss');
      if (Object.keys(JSON.parse(readFileSync(stateFile)).prs).length) violations.push('terminal/history PRs remain tracked');
      if (calls - beforeNext !== 1) violations.push('retired PR consumed the next tick budget');
      const report = { violations, delivered: delivered.length };
      log?.(JSON.stringify(report));
      return report;
    } finally { rmSync(root, { recursive: true, force: true }); }
  },
  judge: report => report.violations,
};
