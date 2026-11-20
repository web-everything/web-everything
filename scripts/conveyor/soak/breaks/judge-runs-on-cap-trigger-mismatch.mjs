/** A referral-hold cap record must not leave an at-round-limit state's verdict null. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const SOURCE = 'scripts/conveyor/pr-stall-sweep.mjs';

export default {
  id: 'judge-runs-on-cap-trigger-mismatch',
  title: 'a cap trigger mismatch runs the judge for the state trigger or reports an explicit fail-closed mismatch',
  card: 'stall sweep: at-round-limit state with a referral-hold cap record',
  fixedBy: { sha: 'pending', where: 'working tree', paths: [SOURCE] },
  fixPresent(root) {
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const { default: scenario } = await import(process.argv[1]);
      process.exitCode = scenario.judge(await scenario.run({ sourceRoot: process.argv[2] })).length ? 1 : 0;
    `, import.meta.url, root], { cwd: root, env: process.env, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
    return !probe.error && probe.status === 0;
  },
  async run({ sourceRoot = ROOT } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'soak-judge-cap-mismatch-'));
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
      const comment = (body, hoursAgo) => ({ author: { login: AUTOMATION_LOGINS[0] },
        createdAt: new Date(now - hoursAgo * 3600_000).toISOString(), body });
      const hold = comment('review paused: 1 referral needs a ruling\n\nWaiting on your ruling (block, card or not-real):\n- `scripts/referral.mjs:7` — referral finding\n\n<!-- review-referral-hold: abcdef0123456789 -->', 4);
      const review = comment('🔁 review — changes requested\n\nRecorded by agent (unattended review-loop) via the declared `review-pr` operation.\n\n### Findings\n- `scripts/review.mjs:5` — review finding', 5);
      for (const [name, comments] of [['review evidence', [review, hold]], ['no review evidence', [hold]]]) {
        if (detectRoundCap({ comments, pr, head, repo, state: 'at-round-limit' })?.trigger !== 'referral-hold') {
          violations.push(`${name}: fixture must have a referral-hold cap record`);
        }
        const calls = [];
        const out = await runStallSweep({ now, env: {}, dir: join(dir, name), log: () => {},
          settings: { value: { ...STALL_SWEEP_DEFAULTS, mode: 'shadow' }, sources: { mode: 'soak' }, errors: [] },
          gh: () => { throw Error('unexpected GitHub call'); },
          dispatchRestart: () => { throw Error('unexpected restart dispatch'); },
          readFiles: () => ['scripts/review.mjs'],
          judge: args => { const verdict = judgeRound(args); calls.push({ args, verdict }); return verdict; },
          read: () => ({ now, unreadable: [], liveJobs: [], drainSkips: [], prs: [{ repo, number: pr,
            title: 'cap trigger mismatch', state: 'OPEN', isDraft: false, headRefOid: head,
            updatedAt: old, createdAt: old, headCommittedAt: old, body: '', labels: [{ name: 'status:at-round-limit' }],
            statusCheckRollup: [], labelEvents: [], comments }] }) });
        if (calls.length !== 1 || calls[0].args.trigger !== 'review-cap'
          || calls[0].args.comments !== comments) violations.push(`${name}: judge must run once for review-cap with the thread evidence`);
        const item = out.items?.[0];
        if (out.items?.length !== 1 || item.state !== 'at-round-limit'
          || item.prHead !== `${repo}#${pr}@${head}` || !item.verdict
          || JSON.stringify(out).includes('not an object')) violations.push(`${name}: missing judged verdict: ${JSON.stringify(out.items)}`);
        if (name === 'review evidence') {
          if (calls[0]?.verdict.evidence?.rounds !== 1 || item?.verdict !== calls[0]?.verdict.verdict) {
            violations.push('review evidence: the state trigger must determine the judged verdict');
          }
        } else if (item?.verdict !== 'escalate' || item?.lane !== 'operator'
          || !item?.reason?.includes('cap-trigger-mismatch: state=review-cap record=referral-hold')) {
          violations.push('no review evidence: missing explicit mismatch reason and operator fallback');
        }
        if (out.errors.length || out.act.length) violations.push(`${name}: mismatch must take no automatic action or encounter IO errors`);
      }
      return { violations };
    } catch (error) { return { violations: [...violations, error.message] }; }
    finally { rmSync(dir, { recursive: true, force: true }); }
  },
  judge: report => report.violations,
};
