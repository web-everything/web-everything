/** PR #5948: a stable fleet must make progress across budget-limited ticks and restarts. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMergeWatch } from '../../pass-daemons/pr-merge-watch-pass.mjs';

const SOURCE = 'scripts/conveyor/pass-daemons/pr-merge-watch-pass.mjs';
const head = 'a'.repeat(40);
const repos = ['example/first', 'example/second'];
const at = minute => new Date(Date.UTC(2026, 9, 25, 0, minute)).toISOString();
export default {
  id: 'merge-watch-budget-starvation',
  title: 'stable open discovery starves later ready PRs and merge checks while closed entries accumulate',
  card: 'PR #5948',
  fixedBy: { sha: 'HEAD', where: 'lane/daemon-events-merge', paths: [SOURCE] },
  fixPresent(root) { return readFileSync(join(root, SOURCE), 'utf8').includes("join(stateDir, 'cursor.json')"); },
  async run({ log = () => {}, runPass = runMergeWatch } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'soak-merge-watch-'));
    const stateDir = join(root, 'state');
    const violations = [], events = [], requests = [];
    let now = at(0), calls = 0;
    const closed = new Set();
    try {
      mkdirSync(stateDir);
      for (const repo of repos) {
        const prs = { 999: { merged: false, heads: { [head]: { since: null, alerted: false } } } };
        // This set exceeds a whole tick on its own. It must disappear, not be polled forever.
        if (repo === repos[0]) for (let n = 1000; n < 1200; n++) {
          prs[n] = { merged: false, heads: { [head]: { since: null, alerted: false } } };
        }
        writeFileSync(join(stateDir, `${encodeURIComponent(repo)}.json`), JSON.stringify({ prs }));
      }
      const gh = args => {
        calls++;
        if (args[0] === 'pr' && args[1] === 'view') return {
          number: Number(args[2]), state: 'OPEN', headRefOid: head, isDraft: false,
          labels: [{ name: 'review:accepted' }, { name: 'red-team:clear' }], mergeStateStatus: 'CLEAN',
        };
        if (args[0] !== 'api' || args.length !== 2) throw Error('unexpected or mutating GitHub call');
        const [path, query] = args[1].split('?');
        if (path.endsWith('/pulls') && new URLSearchParams(query).get('state') === 'open') {
          return Array.from({ length: 60 }, (_, i) => ({ number: i + 1, state: 'open', head: { sha: head } }))
            .filter(p => !closed.has(`${path.slice(6, -6)}#${p.number}`));
        }
        if (/\/pulls\/\d+$/.test(path)) {
          const number = Number(path.split('/').at(-1));
          return { number, state: 'closed', merged_at: number === 999 ? at(0) : null };
        }
        if (path.endsWith('/comments') || path.endsWith('/timeline')) return [];
        if (path.endsWith('/check-runs')) return { check_runs: [] };
        if (path.endsWith(`/commits/${head}`)) return { sha: head, commit: { committer: { date: now } } };
        throw Error('unexpected GitHub endpoint');
      };
      // Each call reloads all durable state, as a scheduler one-shot/restarted daemon does.
      for (let tick = 0; tick < 30; tick++) {
        if (tick === 20) closed.add(`${repos[0]}#1`);
        if (tick === 25) closed.clear();
        now = at(tick * 2);
        calls = 0;
        await runPass({ repos, gh, now, stateDir, settings: { readyNotMergingMinutes: 1 },
          signalLogs: () => [], log: () => {}, emitEvent: async event => { events.push(event); return true; } });
        requests.push(calls);
        if (calls > 128) violations.push(`tick ${tick} exceeded the shared request bound`);
      }
      for (const repo of repos) {
        for (let pr = 1; pr <= 60; pr++) {
          if (events.filter(e => e.repo === repo && e.pr === pr && e.kind === 'pr-ready-not-merging').length !== 1) {
            violations.push(`${repo}#${pr} did not deliver readiness exactly once within 30 ticks including reopening`);
          }
        }
        if (events.filter(e => e.repo === repo && e.kind === 'pr-merged' && e.pr === 999).length !== 1) {
          violations.push(`${repo} merge check did not deliver exactly once within 30 ticks`);
        }
      }
      const saved = JSON.parse(readFileSync(join(stateDir, `${encodeURIComponent(repos[0])}.json`), 'utf8'));
      if (Object.keys(saved.prs).some(n => Number(n) >= 1000)) violations.push('closed-unmerged entries were not retired');
      log(`30 ticks; ${events.length} events; max ${Math.max(...requests)} requests/tick; ${Object.keys(saved.prs).length} retained PRs`);
    } finally { rmSync(root, { recursive: true, force: true }); }
    return { violations };
  },
  judge(report) { return report.violations; },
};
