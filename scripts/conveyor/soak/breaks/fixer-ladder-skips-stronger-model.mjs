/**
 * @file breaks/fixer-ladder-skips-stronger-model.mjs — live break 2026-10-04, PR #3833. The regular daemon fixer
 * (Sonnet) twice failed to address the operator's block rulings; nothing escalated the model, so the orchestrator
 * handed the PR to an Opus agent BY HAND. Before the ladder the second miss simply parked the PR for the operator.
 *
 * FIX: a configurable fixer-escalation ladder (config extends the platform default, models from the routing policy):
 * miss 1 resend, miss 2 a stronger model with a failing test first, miss 3 cross-provider if available (dormant
 * by default: the critical-work gate keeps fix on Claude), then the operator.
 *
 * SCENARIO: one finding ruled block on H1, coming back on H2, H3, H4. RED = miss 2 is not dispatched on opus with the
 * test-first instruction (the old behaviour parked it), miss 1 carries a model override (it must be the same fixer),
 * or miss 3 is not handed to the operator with the ladder trail.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');

const CHILD = `
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const src = process.env.SOAK_SOURCE_ROOT;
const imp = (rel) => import(pathToFileURL(join(src, rel))).catch(() => null);
const jury = await imp('scripts/lib/jury-core.mjs');
const core = await imp('scripts/conveyor/reconcile-core.mjs');
const pass = await imp('scripts/conveyor/reconcile-pass.mjs');
const ledger = await imp('scripts/lib/ruling-ledger.mjs');
const ladderMod = await imp('scripts/conveyor/fixer-ladder.mjs');
const repo = 'web-everything/web-everything';
const H = ['a', 'b', 'c', 'd'].map((c) => c.repeat(40));
const T0 = Date.parse('2026-10-04T03:00:00Z');
const original = { summary: 'human-review protection omits JSON files that supply policy values through pointers', file: 'backlog/xcs4nce-policy.md', line: 3, verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
const key = jury.referralFindingKey('judge', original);
const mk = (head, runId, rulings = []) => { const reviewer = jury.mandatoryReferralReviewer(runId);
  return { version: 1, repo, pr: 3833, head, runId, reviewer, authorBody: '<!-- authored-by-actor: a -->', attempted: true,
    referrals: [{ key, seat: 'judge', original, finding: jury.normalizeFinding(original) }],
    rulings: rulings.map((r, i) => ({ id: 'r' + i, key, reviewerId: reviewer.id, lens: reviewer.lens, result: r, rationale: 'must cover pointed-to files', evidence: ['e'] })) }; };
const cm = (rec, min) => ({ body: jury.renderReferralRecord(rec), createdAt: new Date(T0 + min * 60000).toISOString(), author: { login: 'web-everything' } });
const thread = (n) => [cm(mk(H[0], 'run-1'), 1), cm(mk(H[0], 'run-1', ['block']), 3), ...[1, 2, 3].slice(0, n - 1).map((i) => cm(mk(H[i], 'run-' + (i + 1)), 20 * i))];
const ladder = ladderMod ? ladderMod.loadFixerLadder({ override: null }) : null;
const plan = (n) => { let pr = { number: 3833, state: 'OPEN', headRefName: 'lane/x', headRefOid: H[n - 1], labels: [{ name: 'review:human' }, { name: 'advisory:changes' }],
    mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'gate', status: 'COMPLETED', conclusion: 'SUCCESS' }], comments: thread(n) };
  if (pass.enrichPrsWithIgnoredRulings) [pr] = pass.enrichPrsWithIgnoredRulings([pr], ladder ? { humanAt: ladder.humanAt } : {});
  return core.planReconcile({ prs: [pr], agents: [], now: T0 + 3600e3, requiredChecks: ['gate'], ...(ladder ? { fixerLadder: ladder } : {}) }); };
const view = (p) => ({ dispatch: p.dispatch.map((d) => [d.kind, d.mode ?? null, d.rulingNotAddressed?.rung?.id ?? null, d.rulingNotAddressed?.route?.model ?? null]),
  notes: p.notes.map((x) => [x.kind, x.text]), refusals: p.refusals.map((r) => r.kind) });
const out = { ladder: !!ladder, m1: view(plan(2)), m2: view(plan(3)), m3: view(plan(4)) };
const d2 = plan(3).dispatch[0]?.rulingNotAddressed;
out.m2Brief = d2 && ledger?.fixerRulingBrief ? ledger.fixerRulingBrief(d2) : null;
process.stdout.write(JSON.stringify(out));
`;

export default {
  id: 'fixer-ladder-skips-stronger-model',
  title: 'a ruling the fixer keeps ignoring never reaches a stronger model: the second miss just parks for the operator',
  card: 'operator extension 2026-10-04 ~09:20 ET; live incident PR #3833 (regular fixer twice failed, an Opus agent was dispatched by hand)',
  fixedBy: { sha: 'b01658095e2513f2b0ca7f5923b08ce0723f851c', where: 'lane/fix-ruling-needed-surface', paths: [
    'scripts/lib/fixer-escalation-policy.mjs', 'scripts/conveyor/fixer-ladder.mjs', 'scripts/lib/ruling-ledger.mjs',
    'scripts/conveyor/reconcile-core.mjs', 'scripts/conveyor/reconcile-pass.mjs', 'scripts/conveyor/reconcile-fix-dispatch.mjs',
    'scripts/lib/dispatch-routing-policy.json'] },
  fixPresent(root) { return existsSync(join(root, 'scripts/lib/fixer-escalation-policy.mjs')); },
  async run({ log, sourceRoot = REPO_ROOT } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'soak-fixer-ladder-'));
    const violations = [];
    try {
      const childFile = join(dir, 'child.mjs');
      writeFileSync(childFile, CHILD);
      let out;
      try {
        out = JSON.parse(execFileSync('node', [childFile], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SOAK_SOURCE_ROOT: sourceRoot } }));
      } catch (e) {
        violations.push({ invariant: 'scenario-runs', detail: `the scenario child crashed: ${String(e?.stderr || e?.message || e).split('\n').slice(0, 3).join(' | ')}` });
        return { violations };
      }
      log?.(JSON.stringify(out));
      const [m1, m2, m3] = [out.m1, out.m2, out.m3];
      if (m1.dispatch.length !== 1 || m1.dispatch[0][2] !== 'resend' || m1.dispatch[0][3] !== null) {
        violations.push({ invariant: 'miss-1-resend', detail: `miss 1 must resend to the same fixer with no model override; got ${JSON.stringify(m1.dispatch)}` });
      }
      if (m2.dispatch.length !== 1 || m2.dispatch[0][2] !== 'stronger-model' || !/opus/.test(m2.dispatch[0][3] ?? '')) {
        violations.push({ invariant: 'miss-2-stronger-model', detail: `miss 2 must be dispatched on a stronger model (opus, from the routing policy); got dispatch=${JSON.stringify(m2.dispatch)} refusals=${m2.refusals.join(',') || 'none'} notes=${m2.notes.map((n) => n[0]).join(',') || 'none'} (parking for the operator here is the live defect)` });
      }
      if (!/write a failing test for EACH finding/.test(out.m2Brief ?? '')) {
        violations.push({ invariant: 'miss-2-test-first', detail: 'the stronger-model rung must tell the fixer to write a failing test for each finding first' });
      }
      const dispute = m3.notes.find((n) => n[0] === 'ruling-dispute');
      if (m3.dispatch.length !== 0 || !dispute || !/Ladder so far: resend > stronger-model/.test(dispute[1])) {
        violations.push({ invariant: 'miss-3-operator', detail: `miss 3 (no cross-provider fixer available) must go to the operator with the ladder trail; got dispatch=${JSON.stringify(m3.dispatch)} note=${dispute?.[1] ?? 'none'}` });
      }
      return { violations };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
