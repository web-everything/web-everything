/** PR #7109: a completed label swap with a lost response must resume through observation. */
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const PATHS = ['scripts/operations/effect-executor.mjs', 'scripts/operations/review-pr-io.mjs'];
const HEAD = 'd20084f7c427cdb0000c40f298fff4f6bdff3179';

export default {
  id: 'effect-unknown-label-swap-observed',
  title: 'PR #7109 pending label swap resumes from live evidence without replaying the write',
  card: 'PR #7109 unknown label swap outcome recovery',
  fixedBy: { sha: 'HEAD', where: 'pending label swap observation', paths: PATHS },
  // Always require the behavioral probe; source markers cannot establish recovery.
  fixPresent() { return true; },
  async run({ sourceRoot = process.env.SOAK_TREE_ROOT || ROOT } = {}) {
    const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
    const { applyPendingEffects } = await load(PATHS[0]);
    const { createReviewPrSinks } = await load(PATHS[1]);
    const { REVIEW_EFFECTS } = await load('scripts/operations/review-pr.mjs');
    const { createMemoryRunStore } = await load('scripts/operations/run-store.mjs');
    const { createRegistry, op } = await load('scripts/operations/registry.mjs');
    const { effect } = await load('scripts/operations/step-kinds.mjs');
    const { startRun, advance, runStatus } = await load('scripts/operations/engine.mjs');
    const violations = [];
    const check = (ok, reason) => { if (!ok) violations.push(reason); };
    const payload = { pr: 7109, repo: 'o/n', reviewedHead: HEAD, addLabel: 'review:accepted',
      removeLabels: ['review:pending'], to: 'accepted', bodyFile: '7109-verdict.md' };
    const labels = ['ready-to-merge', 'review:accepted', 'review-round:1', 'status:ready-to-merge', 'red-team:pending'];
    const registry = createRegistry();
    const body = '# Review 7109\n\nAccepted after checking this run.';
    registry.register(op('observe-label', { land: effect({ effects: () => [
      { type: REVIEW_EFFECTS.LABEL, payload },
      { type: REVIEW_EFFECTS.WRITE_UP, payload: { bodyFile: payload.bodyFile, body } },
    ] }) }));

    for (const state of ['same-head', 'unmarked-comment', 'unrelated-comment', 'no-comment', 'moved-head', 'unreadable-labels', 'source-labels-still-present', 'later-changes', 'ruling-hold', 'pipeline-refusal', 'not-applied']) {
      const store = createMemoryRunStore();
      const run = advance(startRun({ op: 'observe-label', id: `observe-${state}`, registry }), { registry });
      Object.assign(run.effects[0], { status: 'pending', attempts: 1, error: 'UNKNOWN: response lost',
        lastAttemptAt: '2026-11-18T19:15:30.155Z' });
      run.effects[1].status = 'applied';
      store.write(run);
      let writes = 0;
      const root = mkdtempSync(join(tmpdir(), 'observe-label-'));
      const readLabels = () => state === 'unreadable-labels' ? null
        : state === 'later-changes' ? [...labels, 'review:changes']
        : state === 'ruling-hold' ? [...labels, 'advisory:ruling-needed']
        : state === 'source-labels-still-present' ? ['review:pending', 'ready-to-merge'] : labels;
      const sinks = createReviewPrSinks({ root, runStore: store,
        labelProvider: { readPrState: () => ({ state: 'OPEN', body: '', headRefOid: HEAD, labels: readLabels() }), readComments: () => state === 'no-comment' ? [] : [{
          author: { login: 'web-everything' }, body: `${state === 'unrelated-comment' ? 'Unrelated review.' : body}\n\n<!-- reviewed-sha: ${HEAD} -->${!['unmarked-comment', 'unrelated-comment'].includes(state) ? `\n<!-- review-attempt: ${run.effects[0].key} -->` : ''}`, createdAt: '2026-11-18T19:16:30Z',
        }, ...(state === 'pipeline-refusal' ? [{ author: { login: 'web-everything' }, body: '<!-- mandatory-referrals-v1: truncated' }] : [])] },
        readHead: () => state === 'moved-head' ? 'b'.repeat(40) : HEAD,
        readLabels,
        runNode: () => { writes++; throw new Error('sink replayed'); },
      });
      if (state === 'not-applied') sinks[REVIEW_EFFECTS.LABEL].observeOutcome = async () => 'not-applied';
      let outcome;
      let refusal;
      try { outcome = await applyPendingEffects(run, { sinks, store }); }
      catch (error) { refusal = error; }
      finally { rmSync(root, { recursive: true, force: true }); }
      if (state === 'same-head') {
        check(!refusal, 'observable pending swap was refused');
        const saved = store.read(run.id);
        check(saved.effects[0].status === 'applied' && saved.effects[0].result?.observed === true
          && saved.effects[0].error === null && saved.effects[0].attempts === 1,
        'observed outcome was not durably applied without another attempt');
        if (outcome) {
          check(runStatus(advance(outcome.run, { registry }), { registry }) === 'complete', 'observed run did not advance');
          await applyPendingEffects(saved, { sinks, store });
        }
      } else {
        check(refusal instanceof Error, `${state}: unknown swap was allowed to resume`);
        check(JSON.stringify(store.read(run.id)) === JSON.stringify(run), `${state}: unknown record changed`);
      }
      check(writes === 0, `${state}: label sink was replayed`);
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
