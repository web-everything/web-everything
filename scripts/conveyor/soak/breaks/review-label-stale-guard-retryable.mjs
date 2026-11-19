/** A label CLI refused at entry by the stale-code guard must remain retryable. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const SOURCE = 'scripts/operations/review-pr-io.mjs';

export default {
  id: 'review-label-stale-guard-retryable',
  title: 'a stale-guard label refusal proves nothing landed and permits retry',
  card: 'operator stale-guard label retry',
  fixedBy: { sha: 'HEAD', where: SOURCE, paths: [SOURCE] },
  fixPresent(root) {
    // Probe classifier support separately: a regressed sink must fail the required-pass body,
    // rather than switch that same failing assertion into defineBreakTest's it.fails branch.
    const code = `
      try {
        const { isPreWriteRefusal } = await import(process.argv[1]);
        const refusal = 'review-set-label: this checkout is 2 commit(s) behind origin/main in code it runs '
          + '(STALE code from this checkout) — run from an up-to-date lane. Nothing was changed.';
        process.stdout.write(isPreWriteRefusal(refusal) ? 'retryable' : 'stranded');
      } catch { process.stdout.write('stranded'); }
    `;
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', code, pathToFileURL(join(root, SOURCE)).href], {
      encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return !probe.error && probe.status === 0 && probe.stdout === 'retryable';
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
    const { createReviewPrSinks } = await load(SOURCE);
    const { REVIEW_EFFECTS } = await load('scripts/operations/review-pr.mjs');
    const { assertOperatorCliFresh } = await load('scripts/lib/main-staleness.mjs');
    log?.('fixture imports loaded');
    const root = mkdtempSync(join(tmpdir(), 'soak-stale-label-'));
    const violations = [];
    const unexpected = () => { throw new Error('unexpected fixture IO or wait'); };
    try {
      let refusal;
      try {
        assertOperatorCliFresh(root, {
          label: 'review-set-label', skipUnderVitest: false,
          env: { WE_OPERATOR_CLI_FRESH_FALLBACK: 'off' },
          run: args => {
            if (!['fetch', 'rev-list'].includes(args[0])) return unexpected();
            return { status: 0, stdout: args[0] === 'rev-list' ? '2' : '' };
          },
          listBehindFiles: () => ['scripts/review-set-label.mjs'],
          spawn: unexpected, laneSpawn: unexpected, readSettings: unexpected,
          exists: unexpected, emitEvent: unexpected, exit: unexpected, write: unexpected,
        });
      } catch (error) { refusal = error.message; }
      if (!refusal?.startsWith('review-set-label: this checkout is 2 commit(s) behind'))
        return { violations: ['fixture did not reach the stale guard'] };
      log?.('stale guard refused');
      const bodyFile = 'verdict.md', body = '# verdict', runId = 'stale-label';
      const payload = { pr: 7, repo: 'o/n', to: 'accepted', actor: 'operator', bodyFile, reviewedHead: 'a'.repeat(40) };
      let labelCalls = 0, gateCalls = 0;
      const options = {
        root, runStore: { read: () => ({ id: runId, effects: [{ type: REVIEW_EFFECTS.WRITE_UP, status: 'applied', payload: { bodyFile, body } }] }) },
        env: { WE_REVIEW_START_EARLY: 'on' },
        sleep: unexpected, now: () => 0,
        publishGate: ({ expectedHead }) => {
          gateCalls++;
          log?.('publish gate: CI allowed');
          // The acceptance wait requires explicit authorization, not just an empty checks list.
          return { allowed: true, headSha: expectedHead, checks: [] };
        },
        readPublishHead: ({ expectedHead }) => expectedHead,
        postComment: unexpected, labelProvider: {}, readLabels: unexpected, setLabels: unexpected,
        referralJudge: unexpected, postRedTeamCheckRun: unexpected, shadowGitExec: unexpected,
        readChangedLines: unexpected, mirrorReferral: unexpected, cardReadable: unexpected,
        readLedgerRows: unexpected, appendLedgerRow: unexpected, appendShadowJournal: unexpected,
      };
      const sinks = createReviewPrSinks({ ...options,
        runNode: () => {
          labelCalls++;
          throw Object.assign(new Error('exit 1'), { stdout: JSON.stringify({ error: refusal }) });
        },
      });
      await sinks[REVIEW_EFFECTS.WRITE_UP]({ bodyFile, body }, { runId });
      log?.('write-up staged; entering label sink');
      const error = await sinks[REVIEW_EFFECTS.LABEL](payload, { runId }).catch(e => e);
      if (gateCalls !== 1 || labelCalls !== 1) violations.push('fixture did not reach the label CLI exactly once after CI authorization');
      if (error?.notApplied !== true) violations.push('stale refusal stranded the label with an UNKNOWN outcome');
      if (!error?.message?.includes(refusal)) violations.push('label sink did not report the stale-guard refusal');
      log?.(`stale label refusal: notApplied=${error?.notApplied === true}, gateCalls=${gateCalls}, labelCalls=${labelCalls}, error=${error?.message}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    return { violations };
  },
  judge: report => report.violations,
};
