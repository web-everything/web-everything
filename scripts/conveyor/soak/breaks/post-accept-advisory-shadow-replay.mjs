/** Post-accept shadow observations survive repeated reviews without changing live review effects. */
import { isDeepStrictEqual } from 'node:util';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const CLI = 'scripts/operations/review-loop-cli.mjs';
const PATH = 'scripts/operations/review-pr.mjs';
const REPO = 'example/advisory-shadow-replay';
const HEAD_A = 'a'.repeat(40), HEAD_B = 'b'.repeat(40);

export default {
  id: 'post-accept-advisory-shadow-replay',
  title: 'post-accept advisory replay deduplicates observations and preserves live review on telemetry failure',
  card: 'x5vjl3o / #7618 / PR #6218',
  fixedBy: { sha: 'HEAD', where: 'lane/x5vjl3o-post-accept-shadow',
    paths: [CLI, 'scripts/lib/review-loop-policy.mjs', 'scripts/operations/review-pr-io.mjs'] },
  fixPresent(root) {
    try { return readFileSync(join(root, CLI), 'utf8').includes('await recordAdvisoryRating('); }
    catch { return false; }
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const violations = [];
    const check = (ok, message) => { if (!ok) violations.push(message); };
    const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
    try {
      const { createRegistry } = await load('scripts/operations/registry.mjs');
      const { createMemoryRunStore } = await load('scripts/operations/run-store.mjs');
      const { judgeOutcome } = await load('scripts/operations/cli-adapter.mjs');
      const { reviewPrOperation, REVIEW_EFFECTS } = await load(PATH);
      const { runReviewLoopOnce } = await load(CLI);
      const { recordPostAcceptAdvisoryShadow, recordPostAcceptAdvisoryLoops,
        recordPostAcceptAdvisoryRating } = await load('scripts/operations/review-pr-io.mjs');
      const { postAcceptAdvisoryShadowReport } = await load('scripts/lib/review-loop-policy.mjs');

      for (const scenario of ['CONFIRMED', 'PLAUSIBLE', 'writer-error', 'logger-error']) {
        const execute = async mode => {
          const rows = [], effects = [], outcomes = [], logs = [];
          const io = { readLedgerRows: () => structuredClone(rows),
            appendLedgerRow: row => { rows.push(structuredClone(row)); return { ok: true }; } };
          const store = createMemoryRunStore();
          // Inject every external effect: no GitHub, Git, juror processes or host state.
          const forbidden = () => { throw new Error('unexpected filing or learning effect'); };
          const review = async (head, id, later) => {
            const declaration = reviewPrOperation({ readPr: ({ pr, repo }) => ({
              state: 'OPEN', createdAt: '', headRefName: 'lane/shadow-replay', body: 'shadow replay',
              detail: { pr, repo, title: 'shadow replay', url: `https://example.invalid/${pr}`,
                labels: ['review:pending'], humanRequired: false, reviewClass: 'pending',
                disposition: { mode: 'converge', autoLand: false }, escalationReason: [],
                advisoryComment: null, humanComment: null,
                diffStat: [{ path: PATH, additions: 1, deletions: 0 }] },
              net: { paths: [PATH], base: HEAD_A, rev: head, scored: true },
              diff: { text: '--- a/x\n+++ b/x\n+one line\n', scored: true },
            }) });
            const registry = createRegistry();
            registry.register(declaration);
            const out = await runReviewLoopOnce({ declaration, registry,
              argv: ['--pr=6218', `--repo=${REPO}`], store, mintRunId: () => id,
              now: () => '2026-11-02T16:00:00.000Z',
              sinks: Object.fromEntries(Object.values(REVIEW_EFFECTS).map(type => [type, async payload => {
                effects.push({ type, payload }); return { ok: true };
              }])),
              readAcceptancePr: () => ({ headRefOid: head, comments: [] }),
              cardReadable: () => false, findFiledPrevention: () => null, findFiledRoundCards: () => null,
              appendLearning: forbidden, fileItem: forbidden,
              makeJudge: () => async request => judgeOutcome(request.lens === 'correctness' ? {
                summary: 'review', findings: [{ file: PATH, line: 4,
                  summary: later ? 'a fresh description of the defect' : 'improve diagnostic',
                  disposition: later ? 'bug' : 'nit', category: 'correctness/correctness',
                  verdict: scenario === 'PLAUSIBLE' ? 'PLAUSIBLE' : 'CONFIRMED',
                  introduced: true, worseThanBase: true, parallelizable: true,
                  impactIfUnfixed: later ? 'broken' : 'cosmetic' }],
              } : { summary: 'nothing blocking', findings: [] }, {}),
              acceptPolicy: { value: { unattendedAcceptRequiresCleanReferrals: true } },
              advisorySettings: () => ({ value: { mode } }),
              recordAdvisoryShadow: facts => recordPostAcceptAdvisoryShadow({ ...facts, ...io }),
              recordAdvisoryLoops: facts => recordPostAcceptAdvisoryLoops({ ...facts, ...io }),
              recordAdvisoryRating: facts => {
                if (later && scenario.endsWith('error')) throw new Error('rating writer unavailable\n');
                return recordPostAcceptAdvisoryRating({ ...facts, ...io });
              },
              advisoryLog: line => {
                logs.push(line);
                if (scenario === 'logger-error') throw new Error('logger unavailable');
              },
            });
            outcomes.push({ code: out.code, stopped: out.stopped, verdict: out.run.verdict,
              confirm: out.run.findings.confirm, lines: out.lines });
            return out;
          };
          const accepted = await review(HEAD_A, 'cosmetic-accept', false);
          check(accepted.stopped === 'complete' && accepted.run.findings.confirm === 'accept',
            `${scenario}/${mode}: advisory review did not complete acceptance`);
          // A resumed completed run must not record a second accepted-head observation.
          const acceptedRows = structuredClone(rows);
          await review(HEAD_A, 'cosmetic-accept', false);
          check(isDeepStrictEqual(rows, acceptedRows), `${scenario}/${mode}: duplicate accepted-head replay`);
          await review(HEAD_B, 'broken-review', true);
          const beforeReplay = structuredClone(rows);
          await review(HEAD_B, 'broken-review', true);
          check(isDeepStrictEqual(rows, beforeReplay), `${scenario}/${mode}: duplicate later-run replay`);
          return { rows, effects, outcomes, logs };
        };
        const baseline = await execute('off');
        check(baseline.rows.length === 0, `${scenario}/off: wrote shadow observations`);
        for (const mode of ['shadow', 'on']) {
          const result = await execute(mode);
          check(isDeepStrictEqual(result.effects, baseline.effects), `${scenario}/${mode}: changed live effects`);
          check(isDeepStrictEqual(result.outcomes, baseline.outcomes), `${scenario}/${mode}: changed live outcomes`);
          const report = postAcceptAdvisoryShadowReport(result.rows);
          for (const [key, value] of Object.entries({ prs: 1, wouldCard: 1, findings: 1, loopsAfter: 1,
            laterBroken: scenario === 'CONFIRMED' ? 1 : 0,
            unconfirmedBroken: scenario === 'PLAUSIBLE' ? 1 : 0, skipped: 0, unresolved: 0 })) {
            check(report[key] === value, `${scenario}/${mode}: ${key} expected ${value}, got ${report[key]}`);
          }
          check(result.rows.filter(row => row.kind === 'advisory-rating').length === (scenario.endsWith('error') ? 0 : 1),
            `${scenario}/${mode}: wrong later-rating count`);
          if (scenario.endsWith('error')) check(result.logs.some(line => line.includes('live review unaffected')),
            `${scenario}/${mode}: telemetry failure was not reported`);
        }
        log?.(`post-accept shadow replay: ${scenario}`);
      }
    } catch (error) { violations.push(`scenario failed: ${error.stack ?? error}`); }
    return { violations };
  },
  judge: report => report.violations,
};
