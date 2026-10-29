/** PR #5983: a delegated attempt's comment cannot authorize an autonomous park withdrawal. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');

export default {
  id: 'clear-human-refused-park',
  title: 'park recovery preserves refused delegated clearance holds and permits a later operator clearance',
  card: 'x1b8hlo / PR #5983',
  fixedBy: { sha: 'pending', where: 'lane/r130-delegated-sweep', paths: ['scripts/review-set-label.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/review-set-label.mjs'), 'utf8').includes('DELEGATED_CLEARANCE_MARKER');
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const load = rel => import(pathToFileURL(join(sourceRoot, rel)).href);
    const { runReviewLabelCli, buildVerdictComment, withdrawParkOnLiveClearance } = await load('scripts/review-set-label.mjs');
    const { sweepHumanSurfaceRepark } = await load('scripts/conveyor/human-surface-repark.mjs');
    const { verdictLedgerPath, parseLedgerEvents, EVENT_TYPES } = await load('scripts/lib/verdict-ledger.mjs');
    const scratch = mkdtempSync(join(tmpdir(), 'clear-human-refused-park-'));
    const savedEnv = Object.fromEntries(['WE_VERDICT_LEDGER_DIR', 'WE_VERDICT_LEDGER_STORE']
      .map(key => [key, process.env[key]]));
    const realExit = process.exit, realNow = Date.now;
    const expiry = Date.parse('2099-01-01T00:00:00Z');
    const exitSignal = Symbol('expected CLI exit');
    const head = 'a'.repeat(40), violations = [];
    try {
      process.env.WE_VERDICT_LEDGER_STORE = 'home';
      process.exit = code => { throw { signal: exitSignal, code }; };
      for (const failure of ['expiry', 'label failure', 'comment reply lost', 'reassert expiry']) {
        for (const fixed of [false, true]) {
          Date.now = () => expiry - 1;
          process.env.WE_VERDICT_LEDGER_DIR = join(scratch, `${failure}-${fixed}`);
          const park = { author: { login: 'web-everything' }, createdAt: '2026-10-28T20:00:00Z',
            body: `<!-- human-surface-repark: ${head} -->` };
          const comments = [park], output = [];
          let labels = ['review:human', ...(failure === 'reassert expiry' ? ['review:accepted'] : [])];
          let reads = 0, code = 0, recovering = false, recoveryWrites = 0;
          const provider = {
            readPostingIdentity: () => ({ login: 'chalbert', type: 'User' }),
            readPrState: () => {
              reads++;
              if (!recovering && ((failure === 'expiry' && reads === 4)
                || (failure === 'reassert expiry' && reads === 5))) Date.now = () => expiry;
              return { state: 'OPEN', headRefOid: head, body: '', labels: [...labels], comments: [...comments] };
            },
            readComments: () => [...comments], readLabels: () => [...labels],
            setLabels: (_repo, _pr, { add, remove }) => {
              if (recovering) recoveryWrites++;
              if (!recovering && failure === 'label failure') throw new Error('label transport failed');
              labels = [...new Set([...labels.filter(label => !remove.includes(label)), add])];
            },
            postComment: (_repo, _pr, body) => {
              comments.push({ author: { login: 'chalbert' }, body, createdAt: '2026-10-28T20:00:02Z' });
              if (failure === 'reassert expiry') labels = ['review:human']; // concurrent re-park
              if (failure === 'comment reply lost') throw new Error('comment persisted but reply lost');
            },
          };
          try {
            runReviewLabelCli({
              argv: ['5983', '--repo=o/r', '--actor=operator', '--reason=operator ruling',
                ...(fixed ? [] : ['--to=clear-human']), '--channel=daemon', `--expect-head=${head}`,
                '--delegation-json=' + JSON.stringify({ by: 'operator', scope: 'review:human',
                  expires: '2099-01-01T00:00:00Z' })],
              fixedTo: fixed ? 'clear-human' : null, allowClearHuman: true, provider,
              buildComment: buildVerdictComment, emit: line => output.push(line),
              successResult: result => result, refusalResult: result => result, signalFix: () => {},
              fileApprovalPrevention: () => null, findFiledApprovalPrevention: () => null,
            });
          } catch (error) {
            if (error?.signal !== exitSignal) throw error;
            code = error.code;
          }
          const ledger = parseLedgerEvents(readFileSync(verdictLedgerPath('o/r'), 'utf8'));
          if (code !== 1 || comments.length !== 2 || !labels.includes('review:human')
            || ledger.at(-1)?.type !== EVENT_TYPES.LABEL_INPUT || ledger.at(-1)?.label !== 'review:human') {
            violations.push(`${failure}, fixed=${fixed}: CLI did not reach the refused orphan-comment state`);
          }
          recovering = true;
          const sweep = (dryRun = false) => sweepHumanSurfaceRepark({
            dryRun,
            repo: 'o/r', provider, listPrs: () => [{ number: 5983, labels: [...labels], comments: [...comments] }],
            readComments: () => [...comments], readLabelEvents: () => [{ event: 'labeled', label: 'review:human',
              createdAt: '2026-10-28T20:00:01Z' }],
            readNetFiles: () => ({ ok: true, files: [] }), resolveSurfaces: () => 'narrow',
          });
          // Both the immediate race recovery and later sweeps consume the real posted comment.
          if (sweep(true).some(result => result.repark === 'would-withdraw')) {
            violations.push(`${failure}, fixed=${fixed}: dry run advertised an unauthorized withdrawal`);
          }
          withdrawParkOnLiveClearance({ provider, repo: 'o/r', pr: 5983, headSha: head });
          if (recoveryWrites || !labels.includes('review:human')) {
            violations.push(`${failure}, fixed=${fixed}: immediate recovery revived the refused clearance`);
          }
          labels = ['review:human'];
          recoveryWrites = 0;
          sweep();
          sweep();
          if (recoveryWrites || !labels.includes('review:human') || labels.includes('review:accepted')) {
            violations.push(`${failure}, fixed=${fixed}: refused clearance revived by park recovery (${recoveryWrites} writes)`);
          }
          // A later independent ceremony, not the refused attempt, can still release this park.
          labels = ['review:human'];
          recoveryWrites = 0;
          comments.push({ author: { login: 'chalbert' }, createdAt: '2026-10-28T20:00:03Z',
            body: buildVerdictComment({ to: 'clear-human', actor: 'operator', reason: 'fresh approval', headSha: head }) });
          sweep();
          if (recoveryWrites !== 1 || labels.includes('review:human') || !labels.includes('review:accepted')) {
            violations.push(`${failure}, fixed=${fixed}: later independent clearance could not restore acceptance`);
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
    log?.(`clear-human refused park: ${violations.length} violation(s)`);
    return { violations };
  },
  judge(report) { return report.violations; },
};
