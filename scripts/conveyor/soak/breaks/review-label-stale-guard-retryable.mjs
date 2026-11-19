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
    const root = mkdtempSync(join(tmpdir(), 'soak-stale-label-'));
    const violations = [];
    try {
      let refusal;
      try {
        assertOperatorCliFresh(root, {
          label: 'review-set-label', skipUnderVitest: false,
          env: { WE_OPERATOR_CLI_FRESH_FALLBACK: 'off' },
          run: args => ({ status: 0, stdout: args[0] === 'rev-list' ? '2' : '' }),
          listBehindFiles: () => ['scripts/review-set-label.mjs'],
        });
      } catch (error) { refusal = error.message; }
      if (!refusal) return { violations: ['fixture did not reach the stale guard'] };
      const bodyFile = 'verdict.md', body = '# verdict', runId = 'stale-label';
      const payload = { pr: 7, repo: 'o/n', to: 'accepted', actor: 'operator', bodyFile, reviewedHead: 'a'.repeat(40) };
      const options = {
        root, runStore: { read: () => ({ effects: [{ type: REVIEW_EFFECTS.WRITE_UP, status: 'applied', payload: { bodyFile, body } }] }) },
        publishGate: ({ expectedHead }) => ({ headSha: expectedHead, checks: [] }),
        readPublishHead: ({ expectedHead }) => expectedHead,
      };
      const sinks = createReviewPrSinks({ ...options,
        runNode: () => { throw Object.assign(new Error('exit 1'), { stdout: JSON.stringify({ error: refusal }) }); },
      });
      await sinks[REVIEW_EFFECTS.WRITE_UP]({ bodyFile, body }, { runId });
      const error = await sinks[REVIEW_EFFECTS.LABEL](payload, { runId }).catch(e => e);
      if (error?.notApplied !== true) violations.push('stale refusal stranded the label with an UNKNOWN outcome');
      log?.(`stale label refusal: notApplied=${error?.notApplied === true}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    return { violations };
  },
  judge: report => report.violations,
};
