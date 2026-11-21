/**
 * #7202: a review run that applied its verdict, write-up and label swap, then died inside the additive post-record
 * `ledgerEvents` effect, held its head as "review-unfinished" while the reviewer said "already-reviewed-head": the
 * red team never dispatched. Replay the production evidence reader over that exact run shape (and its negatives).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const EVIDENCE = 'scripts/lib/drain-red-team-evidence.mjs';

export default {
  id: 'redteam-trailing-ledger-effect-deadlock',
  title: 'a run with only the additive ledger-events effect left no longer holds the head as review-unfinished',
  card: 'HEAD fix: trailingLedgerOnly in the shared review-unfinished predicate (#7202)',
  fixedBy: { sha: 'HEAD', where: 'HEAD', paths: [EVIDENCE] },
  // Always replay: missing modules or exports must fail rather than become expected failures.
  fixPresent() { return true; },
  async run({ sourceRoot = ROOT } = {}) {
    const violations = [];
    try {
      const { readDrainRedTeamEvidence } = await import(pathToFileURL(join(sourceRoot, EVIDENCE)).href);
      const runsDir = mkdtempSync(join(tmpdir(), 'soak-ledger-'));
      const head = 'c'.repeat(40);
      const eff = (step, status, type) => ({ type: type ?? `review.${step}`, step, status });
      const done = ['write-up', 'label-swap', 'verdict-ledger.append', 'notice'].map(s => eff(s, 'applied'));
      const ledger = status => eff('ledgerEvents', status, 'review.ledger-events');
      const base = { op: 'review-pr', input: { repo: 'web-everything/web-everything', pr: 7202 },
        verdict: { verdict: 'accept' }, findings: { confirm: 'accept', read: { netBasis: { rev: head } } },
        stepTimings: [{ step: 'read', startedAt: new Date(4999 * 10_000 - 1000).toISOString() }] };
      const replay = (name, extra, expectHold) => {
        const rec = { ...base, pending: { kind: 'effect', step: 'ledgerEvents' }, effects: [...done, ledger('pending')], ...extra };
        const result = readDrainRedTeamEvidence({ repo: base.input.repo, pr: 7202, head, runsDir,
          env: { WE_SHARED_RUNS_DIR: runsDir }, readScorecards: () => [],
          list: () => Array.from({ length: 5000 }, (_, i) => `review-pr-${i}`),
          stat: path => ({ mtimeMs: Number(path.match(/review-pr-(\d+)/)[1]) * 10_000 }),
          read: id => (id === 'review-pr-4999' ? rec : null) });
        const held = result?.reason === 'review-unfinished';
        if (expectHold) {
          if (!held) violations.push(`${name}: expected review-unfinished, got ${JSON.stringify(result?.reason)}`);
        } else if (result?.ok === false || result?.reason !== undefined || JSON.stringify(result?.newest ?? result?.loopPayload) !== JSON.stringify(rec)) {
          violations.push(`${name}: expected the run read as finished evidence, got ${JSON.stringify(result?.reason ?? result?.ok)}`);
        }
      };
      replay('ledger effect only pending', {}, false);
      replay('confirmation abstained', { findings: { confirm: 'abstain', read: { netBasis: { rev: head } } } }, true);
      replay('label swap absent', { effects: [eff('write-up', 'applied'), ledger('pending')] }, true);
      replay('label swap also pending', { effects: [eff('write-up', 'applied'), eff('label-swap', 'pending'), ledger('pending')] }, true);
      replay('ledger effect in flight', { effects: [...done, ledger('in-flight')] }, true);
      replay('ledger effect refused', { effects: [...done, ledger('refused')] }, true);
      replay('pending confirm', { pending: { kind: 'confirm', step: 'confirm' } }, true);
      replay('no verdict', { verdict: null }, true);
    } catch (error) { violations.push(`scenario failed: ${error.stack ?? error}`); }
    return { violations };
  },
  judge: report => report.violations,
};
