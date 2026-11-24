/**
 * Replay a planner-skipped red-team queue entry whose check stays unreadable past the pending maximum, through the
 * drain strategy built with NO request function (the default wiring). The overdue head must be re-requested once
 * (block cleared, old reason kept as evidence); a different block reason must never be overridden.
 * Production modules come from sourceRoot; command and state IO is injected, the queue file is a temp file.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const HEAD = 'b'.repeat(40), BASE = 'e'.repeat(40);
const PR = 5283;

export default {
  id: 'redteam-planner-skip-never-requested',
  title: 'a planner-skipped red-team head past the pending maximum is re-requested once, never overriding other blocks',
  card: 'dlv:REDTEAM-PLANNER-SKIP (#7315, #7326)',
  fixedBy: { sha: 'pending', where: 'lane/redteam-planner-skip',
    paths: ['scripts/lib/drain-merge-strategy.mjs', 'scripts/lib/red-team-queue-state.mjs'] },
  fixPresent(root) {
    try { return /export function requestPlannerSkipReprobe\b/.test(readFileSync(join(root, 'scripts/lib/red-team-queue-state.mjs'), 'utf8')); }
    catch { return false; }
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const violations = [];
    const check = (ok, message) => { if (!ok) violations.push(message); };
    const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
    const dir = mkdtempSync(join(tmpdir(), 'soak-planner-skip-'));
    try {
      const { CONSTELLATION_REPOS: { we: { slug: REPO } } } = await load('scripts/lib/constellation-repos.mjs');
      const { createDrainMergeStrategy } = await load('scripts/lib/drain-merge-strategy.mjs');
      const { resolveMergeDeliveryPolicy } = await load('scripts/lib/merge-delivery-policy.mjs');
      for (const blocked of ['planner-skip', 'review-unfinished']) {
        const file = join(dir, `${blocked}.json`);
        writeFileSync(file, JSON.stringify([{ key: `${REPO}#${PR}`, repo: REPO, pr: PR, head: HEAD, enqueuedAt: 1, attempts: 0,
          blocked, blockedReason: 'soak reason' }]));
        const env = { WE_UNDER_TEST: '1', WE_RED_TEAM_GATE_SOURCE: 'check-run', WE_DRAIN_RED_TEAM_PENDING_MAX_MIN: '1',
          WE_RED_TEAM_QUEUE_FILE: file };
        let clock = 1000, stored = { pending: [], followedUp: [] };
        const labels = ['review:accepted', 'ready-to-merge'];
        const exec = (cmd, args) => {
          if (cmd === 'git') {
            if (args[0] === 'rev-parse') return `${BASE}\n`;
            if (args[0] === 'diff') return 'scripts/x.mjs\0';
            return '';
          }
          if (cmd === 'gh') {
            if (args.includes('--slurp')) return '[[]]';
            if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ id: 'PR_NODE', state: 'OPEN', headRefOid: HEAD, baseRefName: 'main', labels });
            return '';
          }
          throw new Error(`unexpected ${cmd}`);
        };
        const s = createDrainMergeStrategy({
          env, cwd: sourceRoot, now: () => clock, exec,
          resolved: { policy: resolveMergeDeliveryPolicy({ tool: { strategy: 'github-merge-queue' } }), note: null },
          isLocalRepo: () => true, localSlug: REPO, statePath: '/injected/queue-state.json',
          readFile: () => JSON.stringify(stored), writeState: (_path, state) => { stored = structuredClone(state); },
          readRedTeamEvidence: () => ({ loopPayload: { verdict: { verdict: 'accept' } }, scheduled: true, inFlight: false, queued: false, recorded: false }),
          readRedTeamCheck: () => ({ ok: false, reason: 'no red-team check run on head' }),
          readGrantScope: () => null, publishNeedsYou: () => {},
          cancelObsoleteRuns: () => {}, batching: { gate: () => ({ admit: true }), observe: () => ({}) },
          log: { write: line => log?.(line) },
        });
        s.enqueue({ num: PR }, HEAD, { comments: [] });
        clock += 60_001;
        s.enqueue({ num: PR }, HEAD, { comments: [] });
        const [row] = JSON.parse(readFileSync(file, 'utf8'));
        if (blocked === 'planner-skip') {
          check(row.blocked === undefined, 'planner-skip: the overdue head was never re-requested (block still set)');
          check(row.reprobeReason === 'soak reason', 'planner-skip: the old reason is not kept as re-request evidence');
        } else check(row.blocked === 'review-unfinished', `${blocked}: a non planner-skip block was overridden`);
      }
    } catch (error) {
      violations.push(`scenario threw: ${error?.message ?? error}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
    return { violations };
  },
  judge: r => r.violations,
};
