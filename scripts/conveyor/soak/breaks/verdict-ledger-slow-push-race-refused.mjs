/**
 * R365 fix 2: a legitimate accept lost eight clearing-ledger push races because
 * the entire backoff schedule (~6.4s) was shorter than one loaded attempt.
 * review-set-label refused (F4), leaving the loop blocked-on-infra.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runSoak } from '../soak.mjs';

const PATHS = ['scripts/lib/verdict-ledger-io.mjs', 'scripts/lib/verdict-ledger.mjs', 'scripts/review-set-label.mjs'];
const DURATION = 20_000;

export default {
  id: 'verdict-ledger-slow-push-race-refused',
  title: 'a legitimate accept survives seven slow verdict-ledger push races without an F4 refusal',
  card: 'R365 fix 2',
  fixedBy: { sha: 'HEAD', where: 'lane/r365-verdict-ledger', paths: PATHS },
  fixPresent(root) {
    try { return readFileSync(join(root, PATHS[0]), 'utf8').includes('clock() - started'); }
    catch { return false; }
  },
  run({ log } = {}) {
    return runSoak({
      name: 'break:verdict-ledger-slow-push-race-refused',
      rounds: 1, daemons: [], mainEvery: 0, fleet: false,
      scorecards: false, junkInCwd: false, log,
      setup() { return { checked: false }; },
      async perRound(w, round, ctx, api) {
        const { appendLedgerRows, LedgerAppendExhaustedError } = await import(pathToFileURL(join(w.simCloneRoot, PATHS[0])).href);
        const { buildVerdictRecord } = await import(pathToFileURL(join(w.simCloneRoot, PATHS[1])).href);
        const repo = 'example/soak-repo';
        const record = buildVerdictRecord({
          repo, pr: 365, verdict: 'accepted', at: '2026-11-01T12:00:00.000Z', source: 'soak',
        });
        const reproduce = (oldBackoff) => {
          let elapsed = 0;
          let quiet = 0;
          let pushes = 0;
          const waits = [];
          let result;
          let error;
          try {
            result = appendLedgerRows({
              board: w.simCloneRoot, repo, records: [record],
              mkdir: () => {}, write: () => {}, rm: () => {}, read: () => null, now: () => 1,
              clock: () => elapsed, random: () => 0,
              sleep(ms) {
                quiet = oldBackoff ? Math.min(ms, 3200) : ms;
                waits.push(quiet);
                elapsed += quiet;
              },
              run(args) {
                if (args[0] === 'fetch') elapsed += DURATION;
                if (args[0] === 'push') {
                  pushes++;
                  // Seven rival writers win first; the final window only clears
                  // when our backoff yields at least one loaded attempt's duration.
                  if (pushes <= 7 || quiet < DURATION) {
                    throw new Error('! [rejected] non-fast-forward (fetch first)');
                  }
                }
                return args[0] === 'diff' ? 'verdict-ledger/soak.jsonl' : '';
              },
            });
          } catch (caught) { error = caught; }
          return { result, error, pushes, waits };
        };
        const before = reproduce(true);
        if (!(before.error instanceof LedgerAppendExhaustedError) || before.pushes !== 8) {
          api.violation('scenario-ran', 'short waits did not reproduce eight lost push races and refused append');
        }
        const after = reproduce(false);
        ctx.checked = true;
        ctx.result = after.result;
        ctx.refused = after.error ? String(after.error.message) : null;
        if (after.pushes !== 8 || after.waits.length !== 7) {
          api.violation('scenario-ran', `expected eight pushes and seven waits, got ${after.pushes} and ${after.waits.length}`);
        }
        api.say(`r00 clearing-ledger: pushes=${after.pushes}, waits=${after.waits.join(',')}, refused=${ctx.refused ?? 'none'}`);
      },
    });
  },
  judge(report) {
    const problems = report.violations.map(v => `[${v.invariant}] ${v.detail}`);
    if (report.fatal) problems.push(`[fatal] ${report.fatal}`);
    if (!report.ctx?.checked) problems.push('[scenario-ran] clearing-ledger append was not exercised');
    if (report.ctx?.refused) problems.push(`[F4] clearing-ledger append refused; loop blocked-on-infra: ${report.ctx.refused}`);
    if (report.ctx?.result?.status !== 'appended' || report.ctx?.result?.rows !== 1
        || report.ctx?.result?.attempts !== 8) {
      problems.push('[clearing-ledger] accepted verdict was not appended on the eighth attempt');
    }
    return problems;
  },
};
