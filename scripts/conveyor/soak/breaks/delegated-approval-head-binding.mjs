/** PR #5983 red-team: a delegated approval row appended after a push must not release the new head's human hold. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');

export default {
  id: 'delegated-approval-head-binding',
  title: 'a delegated approval for head A released a human hold added on head B',
  card: 'PR #5983 red-team eabb48bcd6c52d65 (approval row not bound to its head)',
  fixedBy: { sha: 'pending', where: 'lane/r130-delegated-sweep',
    paths: ['scripts/review-set-label.mjs', 'scripts/lib/verdict-ledger.mjs', 'scripts/lib/pr-state/holds/verdict.mjs',
      'scripts/lib/pr-state/holds/label-input.mjs', 'scripts/lib/pr-state.mjs', 'scripts/conveyor/pr-label-mirror.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/lib/pr-state/holds/verdict.mjs'), 'utf8').includes('export function approvalReleases');
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const load = rel => import(pathToFileURL(join(sourceRoot, rel)).href);
    const { runReviewLabelCli, buildVerdictComment } = await load('scripts/review-set-label.mjs');
    const { verdictLedgerPath, parseLedgerEvents, EVENT_TYPES } = await load('scripts/lib/verdict-ledger.mjs');
    const { default: labelInputHold } = await load('scripts/lib/pr-state/holds/label-input.mjs');
    const { approvalLiftsAfter } = await load('scripts/lib/pr-state/holds/verdict.mjs');
    const scratch = mkdtempSync(join(tmpdir(), 'delegated-approval-head-'));
    const savedEnv = Object.fromEntries(['WE_VERDICT_LEDGER_DIR', 'WE_VERDICT_LEDGER_STORE'].map(key => [key, process.env[key]]));
    const realExit = process.exit, realWrite = process.stderr.write;
    const exitSignal = Symbol('expected CLI exit');
    const headA = 'a'.repeat(40), headB = 'b'.repeat(40), violations = [];
    try {
      process.env.WE_VERDICT_LEDGER_STORE = 'home';
      process.env.WE_VERDICT_LEDGER_DIR = scratch;
      process.exit = code => { throw { signal: exitSignal, code }; };
      process.stderr.write = () => true;
      let labels = ['review:human'], code = 0;
      const provider = {
        readPostingIdentity: () => ({ login: 'chalbert', type: 'User' }),
        readPrState: () => ({ state: 'OPEN', headRefOid: headA, body: '', labels, comments: [] }),
        readLabels: () => labels,
        setLabels: () => { labels = ['review:accepted']; },
        postComment: () => {}, addLabels: () => {}, removeLabels: () => {},
      };
      try {
        runReviewLabelCli({
          argv: ['5983', '--repo=o/r', '--to=clear-human', '--actor=daemon-delegate-R130', '--reason=operator R130',
            '--channel=daemon', `--expect-head=${headA}`, '--delegation-json=' + JSON.stringify({
              by: 'operator R130', scope: `PR 5983 head ${headA}`, expires: '2099-01-01T00:00:00Z' })],
          allowClearHuman: true, provider, buildComment: buildVerdictComment,
          emit: () => {}, successResult: result => result, refusalResult: result => result, signalFix: () => {},
          fileApprovalPrevention: () => null, findFiledApprovalPrevention: () => null,
        });
      } catch (error) {
        if (error?.signal !== exitSignal) throw error;
        code = error.code;
      }
      const ledger = parseLedgerEvents(readFileSync(verdictLedgerPath('o/r'), 'utf8'));
      const approval = ledger.find(row => row.type === EVENT_TYPES.APPROVAL);
      if (code !== 0 || !approval) violations.push(`clearance on head A did not record an approval (exit=${code})`);
      else {
        // The race: the PR moved to head B and gained a new human hold BEFORE the late approval row for A landed.
        const now = Date.parse('2026-10-28T00:00:00Z');
        const holdOnB = { type: EVENT_TYPES.LABEL_INPUT, change: 'added', label: 'review:human', sender: 'operator' };
        if (!labelInputHold.evaluate({ view: { events: [holdOnB, approval] }, facts: { head: { sha: headB }, now } })) {
          violations.push('hand-added human hold on head B released by the approval granted for head A');
        }
        if (approvalLiftsAfter([{ verdict: 'human' }, approval], 0, now, headB)) {
          violations.push('human verdict hold on head B lifted by the approval granted for head A');
        }
      }
    } finally {
      process.exit = realExit;
      process.stderr.write = realWrite;
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(scratch, { recursive: true, force: true });
    }
    log?.(`delegated approval head binding: ${violations.length} violation(s)`);
    return { violations };
  },
  judge(report) { return report.violations; },
};
