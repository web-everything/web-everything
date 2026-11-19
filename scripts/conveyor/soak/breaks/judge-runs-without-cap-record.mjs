/** A findings-less referral hold passed verdict=null and parked with "not an object" instead of running the judge. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const SOURCE = 'scripts/conveyor/pr-stall-sweep.mjs';

export default {
  id: 'judge-runs-without-cap-record',
  title: 'a judged referral hold without a cap record runs the real judge with an empty thread and fails closed',
  card: 'stall sweep: judged waiting state without a detectRoundCap record',
  fixedBy: { sha: '52c1c87ce0', where: 'main', paths: [SOURCE] },
  fixPresent(root) {
    const source = readFileSync(join(root, SOURCE), 'utf8');
    return source.includes('cap?.trigger === trigger || !cap') && source.includes('comments: cap ? pr.comments : []');
  },
  async run({ sourceRoot = ROOT } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'soak-judge-without-cap-'));
    const violations = [];
    try {
      const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
      const { runStallSweep, STALL_SWEEP_DEFAULTS } = await load(SOURCE);
      const { detectRoundCap, judgeRound } = await load('scripts/lib/round-judge.mjs');
      const { AUTOMATION_LOGINS } = await load('scripts/lib/marker-authorship.mjs');
      const { CONSTELLATION_REPOS } = await load('scripts/lib/constellation-repos.mjs');
      const repo = CONSTELLATION_REPOS.we.slug, pr = 14, head = 'a'.repeat(40);
      const now = Date.parse('2026-11-12T18:00:00Z');
      const old = new Date(now - 3 * 3600_000).toISOString();
      const comments = [{ author: { login: AUTOMATION_LOGINS[0] }, createdAt: old,
        body: 'review paused: 2 referrals need a ruling; it resumes on a new push, a ruling, or a send-back\n\n<!-- review-referral-hold: a1b5166bcd74 -->' }];
      if (detectRoundCap({ comments, pr, head, repo })) violations.push('fixture unexpectedly has a cap record');
      const calls = [];
      const out = await runStallSweep({ now, env: {}, dir, log: () => {},
        settings: { value: { ...STALL_SWEEP_DEFAULTS, mode: 'shadow' }, sources: { mode: 'soak' }, errors: [] },
        gh: () => { throw Error('unexpected GitHub call'); },
        dispatchRestart: () => { throw Error('unexpected restart dispatch'); },
        readFiles: () => ['scripts/conveyor/pr-stall-sweep.mjs'],
        judge: args => { calls.push(args); return judgeRound(args); },
        read: () => ({ now, unreadable: [], liveJobs: [], drainSkips: [], prs: [{ repo, number: pr,
          title: 'referral hold without findings', state: 'OPEN', isDraft: false, headRefOid: head,
          updatedAt: old, createdAt: old, headCommittedAt: old, body: '', labels: [],
          statusCheckRollup: [], labelEvents: [], comments }] }) });
      if (calls.length !== 1 || calls[0].trigger !== 'referral-hold'
        || !Array.isArray(calls[0].comments) || calls[0].comments.length !== 0) {
        violations.push('the real judge must run once for referral-hold with an empty thread');
      }
      const item = out.items?.[0];
      if (out.items?.length !== 1 || item.state !== 'ruling-needed:referral-hold'
        || item.prHead !== `${repo}#${pr}@${head}` || item.lane !== 'operator' || item.verdict !== 'send-back'
        || typeof item.command !== 'string' || !item.command.trim()) {
        violations.push(`missing fail-closed judge verdict and operator fallback: ${JSON.stringify(out.items)}`);
      }
      if (JSON.stringify(out).includes('not an object')) violations.push('classifier parked the PR with a null verdict');
      if (out.incomplete || out.errors.length || out.act.length) violations.push('empty judge evidence must remain readable and take no automatic action');
      return { violations };
    } catch (error) { return { violations: [...violations, error.message] }; }
    finally { rmSync(dir, { recursive: true, force: true }); }
  },
  judge: report => report.violations,
};
