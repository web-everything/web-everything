/** PR #5982: rejected delegated clearances must not leave durable clearance authority. */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');

export default {
  id: 'clear-human-admission-ledger',
  title: 'delegated admission retains human holds across partial appends and late expiry, including retries',
  card: 'PR #5982 delegated clearance admission',
  fixedBy: { sha: 'pending', where: 'lane/r130-clear-human-guard', paths: ['scripts/review-set-label.mjs'] },
  fixPresent(root) {
    const source = readFileSync(join(root, 'scripts/review-set-label.mjs'), 'utf8');
    return source.includes('approvalValid(validatedApproval, Date.now())')
      && source.includes('if (!guardedClearHuman) recordLedger()')
      && source.includes('delegation expired between ledger appends')
      && source.includes('refused delegated clearance superseded by a durable human hold')
      && source.includes('assertDelegationCurrent();');
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const load = rel => import(pathToFileURL(join(sourceRoot, rel)).href);
    const { runReviewLabelCli, buildVerdictComment } = await load('scripts/review-set-label.mjs');
    const { verdictLedgerPath, parseLedgerEvents, EVENT_TYPES, appendVerdict, buildLedgerEvent, ledgerEventId } = await load('scripts/lib/verdict-ledger.mjs');
    const { default: labelInputHold } = await load('scripts/lib/pr-state/holds/label-input.mjs');
    const scratch = mkdtempSync(join(tmpdir(), 'clear-human-admission-'));
    const savedEnv = Object.fromEntries(['WE_VERDICT_LEDGER_DIR', 'WE_VERDICT_LEDGER_STORE']
      .map(key => [key, process.env[key]]));
    const realExit = process.exit;
    const realNow = Date.now;
    const expiry = Date.parse('2099-01-01T00:00:00Z');
    const exitSignal = Symbol('expected CLI exit');
    const head = 'a'.repeat(40), violations = [];
    try {
      // Real ledger serialization/appends, confined to a disposable home store: no git or network writes.
      process.env.WE_VERDICT_LEDGER_STORE = 'home';
      process.exit = code => { throw { signal: exitSignal, code }; };
      for (const scenario of ['expired', 'second-read', 'between-appends', 'expiry-read-3', 'expiry-read-4', 'expiry-read-5']) {
        const expired = scenario === 'expired', betweenAppends = scenario === 'between-appends';
        const expireAt = scenario.startsWith('expiry-read-') ? Number(scenario.at(-1)) : null;
        for (const accepted of [false, true]) {
          if (expireAt === 5 && !accepted) continue;
          for (const fixed of [false, true]) {
            process.env.WE_VERDICT_LEDGER_DIR = join(scratch, `${scenario}-${accepted}-${fixed}`);
            for (let attempt = 1; attempt <= 2; attempt++) {
              Date.now = () => expiry - 1;
              const writes = [], output = [];
              let reads = 0, code = 0;
              const provider = {
                readPostingIdentity: () => ({ login: 'chalbert', type: 'User' }),
                readPrState: () => {
                  reads++;
                  if (reads === expireAt) Date.now = () => expiry;
                  if (betweenAppends && reads === 3) {
                    // Mirror a freshly re-applied human hold after observing the A verdict.
                    // Include verdicts in its baseline; an approval written after that
                    // observation would incorrectly release this new hold on head B.
                    const before = parseLedgerEvents(readFileSync(verdictLedgerPath('o/r'), 'utf8'));
                    const mirrored = appendVerdict(buildLedgerEvent({ type: EVENT_TYPES.LABEL_INPUT,
                      repo: 'o/r', pr: 5982, at: new Date().toISOString(), source: 'soak-label-mirror',
                      label: 'review:human', sender: 'operator', change: 'added',
                      clearanceBaseline: before.filter(row => row.type === EVENT_TYPES.VERDICT).map(ledgerEventId) }));
                    if (!mirrored.ok) throw new Error(`soak mirror failed: ${mirrored.errors}`);
                  }
                  return { state: 'OPEN', headRefOid: betweenAppends && reads >= 3 ? 'b'.repeat(40) : head,
                    body: '', comments: [], labels: ['review:human', ...(accepted ? ['review:accepted'] : []),
                      ...(reads >= 2 && scenario === 'second-read' ? ['review:changes'] : [])] };
                },
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
                  sender: 'operator' }, ...ledger] }, facts: { head: { sha: betweenAppends ? 'b'.repeat(40) : head }, now: Date.now() },
              });
              const priorWrites = expireAt === 4 ? [accepted ? 'labels' : 'comment']
                : expireAt === 5 ? ['labels', 'comment'] : [];
              const attemptTypes = betweenAppends
                ? [EVENT_TYPES.VERDICT, EVENT_TYPES.LABEL_INPUT, EVENT_TYPES.LABEL_INPUT]
                : expireAt ? [EVENT_TYPES.VERDICT, ...(expireAt >= 4 ? [EVENT_TYPES.APPROVAL] : []), EVENT_TYPES.LABEL_INPUT] : [];
              const expectedTypes = Array.from({ length: attempt }, () => attemptTypes).flat();
              if (code !== (expired ? 2 : 1) || reads !== (expired ? 0 : expireAt ?? (betweenAppends ? 3 : 2))
                || JSON.stringify(writes) !== JSON.stringify(priorWrites)
                || JSON.stringify(ledger.map(row => row.type)) !== JSON.stringify(expectedTypes)
                || !holds?.some(h => h.code === 'label-input:review:human')
                || !output.join('').includes(expired ? '--delegation-json' : betweenAppends ? 'head changed before acceptance' : 'delegated clearance refused')) {
                violations.push(`clearance escaped admission (scenario=${scenario}, accepted=${accepted}, fixed=${fixed}, attempt=${attempt}, code=${code}, reads=${reads}, rows=${ledger.length}, writes=${writes.length})`);
              }
            }
          }
        }
      }
    } finally {
      process.exit = realExit;
      Date.now = realNow;
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
