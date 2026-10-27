/** PR #5983: a recovery observation cannot turn completed clearance into refusal. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');

export default {
  id: 'clear-human-post-clearance',
  title: 'delegated clearance reports success after a failed recovery read or moved head',
  card: 'PR #5983 post-clearance send-back',
  fixedBy: { sha: 'pending', where: 'lane/r130-delegated-sweep', paths: ['scripts/review-set-label.mjs'] },
  fixPresent(root) {
    const source = readFileSync(join(root, 'scripts/review-set-label.mjs'), 'utf8');
    return source.includes('post-clearance head changed; clearance remains recorded for')
      && !source.includes("fail('delegated clearance refused: post-clearance re-check failed");
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const load = rel => import(pathToFileURL(join(sourceRoot, rel)).href);
    const { runReviewLabelCli, buildVerdictComment } = await load('scripts/review-set-label.mjs');
    const { verdictLedgerPath, parseLedgerEvents, EVENT_TYPES } = await load('scripts/lib/verdict-ledger.mjs');
    const scratch = mkdtempSync(join(tmpdir(), 'clear-human-recovery-'));
    const savedEnv = Object.fromEntries(['WE_VERDICT_LEDGER_DIR', 'WE_VERDICT_LEDGER_STORE']
      .map(key => [key, process.env[key]]));
    const realExit = process.exit, realWrite = process.stderr.write;
    const exitSignal = Symbol('expected CLI exit');
    const head = 'a'.repeat(40), violations = [];
    try {
      process.env.WE_VERDICT_LEDGER_STORE = 'home';
      process.exit = code => { throw { signal: exitSignal, code }; };
      for (const failure of ['read failure', 'head movement']) {
        for (let attempt = 1; attempt <= 2; attempt++) {
          process.env.WE_VERDICT_LEDGER_DIR = join(scratch, `${failure}-${attempt}`);
          const writes = [], output = [], warnings = [];
          let reads = 0, code = 0;
          let labels = ['review:human', 'review:accepted'];
          process.stderr.write = text => { warnings.push(String(text)); return true; };
          const provider = {
            readPostingIdentity: () => ({ login: 'chalbert', type: 'User' }),
            readPrState: () => {
              reads++;
              if (reads === 5 && failure === 'read failure') throw new Error('forge read unavailable');
              return { state: 'OPEN', headRefOid: reads === 5 ? 'b'.repeat(40) : head, body: '',
                labels, comments: [{ author: { login: 'web-everything' }, body: `<!-- human-surface-repark: ${head} -->` }] };
            },
            readLabels: () => labels,
            setLabels: () => { writes.push('labels'); labels = ['review:accepted']; },
            postComment: () => writes.push('comment'),
            addLabels: () => writes.push('add'), removeLabels: () => writes.push('remove'),
          };
          try {
            runReviewLabelCli({
              argv: ['5983', '--repo=o/r', '--to=clear-human', '--actor=operator', '--reason=operator ruling',
                '--channel=daemon', `--expect-head=${head}`, '--delegation-json=' + JSON.stringify({
                  by: 'operator', scope: 'review:human', expires: '2099-01-01T00:00:00Z' })],
              allowClearHuman: true, provider, buildComment: buildVerdictComment,
              emit: line => output.push(line), successResult: result => ({ ok: true, ...result }),
              refusalResult: result => result, signalFix: () => {},
              fileApprovalPrevention: () => null, findFiledApprovalPrevention: () => null,
            });
          } catch (error) {
            if (error?.signal !== exitSignal) throw error;
            code = error.code;
          }
          const ledger = parseLedgerEvents(readFileSync(verdictLedgerPath('o/r'), 'utf8'));
          if (code !== 0 || reads !== 5 || JSON.stringify(writes) !== JSON.stringify(['labels', 'comment'])
            || !output.join('').includes('"ok":true') || output.join('').includes('refused')
            || !warnings.join('').includes('post-clearance')
            || JSON.stringify(ledger.map(row => row.type)) !== JSON.stringify([EVENT_TYPES.VERDICT, EVENT_TYPES.APPROVAL])
            || ledger[0]?.coverage?.headSha !== head || ledger[1]?.approval !== 'clear-human') {
            violations.push(`post-clearance ${failure}: attempt=${attempt}, exit=${code}, reads=${reads}, writes=${writes.join(',')}`);
          }
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
    log?.(`clear-human post-clearance: ${violations.length} violation(s)`);
    return { violations };
  },
  judge(report) { return report.violations; },
};
