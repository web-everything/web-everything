/** PR #5982: rejected delegated clearances must not leave durable clearance authority. */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');

export default {
  id: 'clear-human-admission-ledger',
  title: 'expired delegation and second-read holds leave no clearance ledger rows, including retries',
  card: 'PR #5982 delegated clearance admission',
  fixedBy: { sha: 'pending', where: 'lane/r130-clear-human-guard', paths: ['scripts/review-set-label.mjs'] },
  fixPresent(root) {
    const source = readFileSync(join(root, 'scripts/review-set-label.mjs'), 'utf8');
    return source.includes('approvalValid(validatedApproval, Date.now())')
      && source.includes('if (!guardedClearHuman) recordLedger()');
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const load = rel => import(pathToFileURL(join(sourceRoot, rel)).href);
    const { runReviewLabelCli, buildVerdictComment } = await load('scripts/review-set-label.mjs');
    const { verdictLedgerPath, parseLedgerEvents, EVENT_TYPES } = await load('scripts/lib/verdict-ledger.mjs');
    const { default: labelInputHold } = await load('scripts/lib/pr-state/holds/label-input.mjs');
    const scratch = mkdtempSync(join(tmpdir(), 'clear-human-admission-'));
    const savedEnv = Object.fromEntries(['WE_VERDICT_LEDGER_DIR', 'WE_VERDICT_LEDGER_STORE']
      .map(key => [key, process.env[key]]));
    const realExit = process.exit;
    const exitSignal = Symbol('expected CLI exit');
    const head = 'a'.repeat(40), violations = [];
    try {
      // Real ledger serialization/appends, confined to a disposable home store: no git or network writes.
      process.env.WE_VERDICT_LEDGER_STORE = 'home';
      process.exit = code => { throw { signal: exitSignal, code }; };
      for (const expired of [true, false]) {
        for (const accepted of [false, true]) {
          for (const fixed of [false, true]) {
            process.env.WE_VERDICT_LEDGER_DIR = join(scratch, `${expired}-${accepted}-${fixed}`);
            for (let attempt = 1; attempt <= 2; attempt++) {
              const writes = [], output = [];
              let reads = 0, code = 0;
              const provider = {
                readPostingIdentity: () => ({ login: 'chalbert', type: 'User' }),
                readPrState: () => ({ state: 'OPEN', headRefOid: head, body: '', comments: [],
                  labels: ['review:human', ...(accepted ? ['review:accepted'] : []),
                    ...(++reads >= 2 && !expired ? ['review:changes'] : [])] }),
                readLabels: () => ['review:human'],
                setLabels: () => writes.push('labels'), postComment: () => writes.push('comment'),
                addLabels: () => writes.push('add'), removeLabels: () => writes.push('remove'),
              };
              try {
                runReviewLabelCli({
                  argv: ['5982', '--repo=o/r', '--actor=operator', '--reason=operator ruling',
                    ...(fixed ? [] : ['--to=clear-human']), '--channel=daemon', `--expect-head=${head}`,
                    '--delegation-json=' + JSON.stringify({ by: 'operator', scope: 'review:human',
                      expires: expired ? '2000-01-01T00:00:00Z' : '2099-01-01T00:00:00Z' })],
                  fixedTo: fixed ? 'clear-human' : null, allowClearHuman: true,
                  provider, emit: line => output.push(line), buildComment: buildVerdictComment,
                  successResult: result => result, refusalResult: result => result,
                  signalFix: () => {}, fileApprovalPrevention: () => null, findFiledApprovalPrevention: () => null,
                });
              } catch (error) {
                if (error?.signal !== exitSignal) throw error;
                code = error.code;
              }
              const path = verdictLedgerPath('o/r');
              const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
              const ledger = parseLedgerEvents(text);
              const holds = labelInputHold.evaluate({
                view: { events: [{ type: EVENT_TYPES.LABEL_INPUT, change: 'added', label: 'review:human',
                  sender: 'operator' }, ...ledger] }, facts: { head: { sha: head }, now: Date.now() },
              });
              if (code !== (expired ? 2 : 1) || reads !== (expired ? 0 : 2)
                || writes.length || text.length || !holds?.some(h => h.code === 'label-input:review:human')
                || !output.join('').includes(expired ? '--delegation-json' : 'delegated clearance refused')) {
                violations.push(`clearance escaped admission (expired=${expired}, accepted=${accepted}, fixed=${fixed}, attempt=${attempt}, code=${code}, reads=${reads}, rows=${ledger.length}, writes=${writes.length})`);
              }
            }
          }
        }
      }
    } finally {
      process.exit = realExit;
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(scratch, { recursive: true, force: true });
    }
    log?.(`clear-human admission: ${violations.length} violation(s)`);
    return { violations };
  },
  judge(report) { return report.violations; },
};
