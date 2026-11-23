/**
 * @file breaks/codex-unproductive-jumps-to-claude.mjs — live break 2026-10-14: 22 repairs jumped from
 * two unproductive Codex runs straight to Claude (including PRs #5294, #5281, #5237), as did five
 * stronger-model fixes. The fallback chain must try codex-alt first. The direct-executor policy
 * (2026-11-23) applies the same ladder to critical work, with requiresReview instead of forced Claude.
 *
 * SCENARIO: route an ordinary fix with two unproductive Codex runs on its head, a round-3 ordinary fix
 * with none, and a round-3 fix with two, for ordinary and critical work. All must try codex-alt first.
 * Persisted legacy thresholds must not force Claude or skip codex-alt on takeover or send-back.
 * Without an admitted Gemini path, three unproductive runs record its skip before Claude;
 * four unproductive runs exhaust the default ladder. Every critical dispatch requires review.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');

const CHILD = `
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const src = process.env.SOAK_SOURCE_ROOT;
const imp = (rel) => import(pathToFileURL(join(src, rel)));
const { routeFixExecutor } = await imp('scripts/conveyor/reconcile-fix-dispatch.mjs');
const chainMod = existsSync(join(src, 'scripts/lib/fix-executor-chain.mjs'))
  ? await imp('scripts/lib/fix-executor-chain.mjs') : null;
const chain = chainMod?.resolveFixExecutorChain({ env: {}, platform: {}, repo: {} });
const head = 'a'.repeat(40);
const planned = { repo: 'we', pr: 5294, kind: 'fix', headRefOid: head, round: 1 };
const table = { 'we#5294': [{ head, outcome: 'failed' }, { head, outcome: 'no-change' }] };
const options = {
  setting: { value: 'codex-first', source: 'default' }, chain,
  fixSettings: { strongerModelFromRound: 3 }, loadLadder: () => null,
  launcherAvailable: () => true, readRouted: () => table, criticalFor: () => false,
};
const criticalOptions = { ...options, criticalFor: () => true };
const highThresholdOptions = { ...criticalOptions, chain: { ...chain, criticalClaudeFromRung: 99 } };
const out = {
  unproductive: routeFixExecutor(planned, options),
  strongerModel: routeFixExecutor({ ...planned, pr: 5281, round: 3 }, options),
  combined: routeFixExecutor({ ...planned, round: 3 }, options),
  critical: routeFixExecutor(planned, criticalOptions),
  criticalStrongerModel: routeFixExecutor({ ...planned, pr: 5281, round: 3 }, criticalOptions),
  criticalCombined: routeFixExecutor({ ...planned, round: 3 }, criticalOptions),
  criticalThreshold: routeFixExecutor(planned, { ...criticalOptions,
    readRouted: () => ({ 'we#5294': [...table['we#5294'], { head, outcome: 'failed' }] }) }),
  criticalExhausted: routeFixExecutor(planned, { ...criticalOptions,
    readRouted: () => ({ 'we#5294': [...table['we#5294'], { head, outcome: 'failed' }, { head, outcome: 'failed' }] }) }),
  criticalLegacyThreshold: routeFixExecutor(planned, { ...criticalOptions,
    chain: { ...chain, criticalClaudeFromRung: 1 } }),
  criticalTakeover: routeFixExecutor({ ...planned, takeover: true }, highThresholdOptions),
  criticalRuling: routeFixExecutor({ ...planned, rulingNotAddressed: true }, highThresholdOptions),
};
process.stdout.write(JSON.stringify(out));
`;

export default {
  id: 'codex-unproductive-jumps-to-claude',
  title: 'unproductive Codex and stronger-model fixes jump straight to Claude instead of trying codex-alt',
  card: 'live fix-dispatch daemon log 2026-10-14; PRs #5294, #5281, #5237 (22 unproductive-run fallbacks and 5 stronger-model fixes)',
  fixedBy: { sha: 'ee763548f6c92fdb46b542705f567b518965cbd1', where: 'lane/fix-executor-chain', paths: [
    'scripts/lib/fix-executor-chain.mjs', 'scripts/lib/fix-slot-borrow.mjs',
    'scripts/conveyor/reconcile-fix-dispatch.mjs'] },
  fixPresent(root) { return existsSync(join(root, 'scripts/lib/fix-executor-chain.mjs')); },
  async run({ log, sourceRoot = REPO_ROOT } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'soak-codex-unproductive-'));
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
      for (const [key, invariant, detail] of [
        ['unproductive', 'unproductive-tries-codex-alt', 'two unproductive Codex runs on this head'],
        ['strongerModel', 'stronger-model-tries-codex-alt', 'round-3 ordinary fix with no unproductive runs'],
        ['combined', 'combined-triggers-try-codex-alt', 'round-3 ordinary fix with two unproductive runs'],
        ['critical', 'critical-tries-codex-alt', 'critical work with two unproductive Codex runs'],
        ['criticalStrongerModel', 'critical-stronger-model-tries-codex-alt', 'round-3 critical fix with no unproductive runs'],
        ['criticalCombined', 'critical-combined-triggers-try-codex-alt', 'round-3 critical fix with two unproductive runs'],
        ['criticalLegacyThreshold', 'critical-legacy-threshold-ignored', 'critical work with two unproductive runs and retired criticalClaudeFromRung=1'],
        ['criticalTakeover', 'critical-takeover-tries-codex-alt', 'critical takeover with retired criticalClaudeFromRung=99'],
        ['criticalRuling', 'critical-ruling-tries-codex-alt', 'critical ruling-not-addressed with retired criticalClaudeFromRung=99'],
      ]) {
        const decision = out[key];
        if (decision.executor !== 'codex' || decision.rung !== 'codex-alt') {
          violations.push({ invariant, detail: `${detail} must pick codex-alt before Claude; got ${JSON.stringify(decision)}` });
        }
      }
      for (const [key, invariant, detail] of [
        ['criticalThreshold', 'critical-skips-unadmitted-gemini', 'critical work with three unproductive runs and no admitted Gemini path'],
        ['criticalExhausted', 'critical-exhausts-ladder', 'critical work with four unproductive runs'],
      ]) {
        const decision = out[key];
        if (decision.executor !== 'claude' || decision.rung !== 'claude') {
          violations.push({ invariant, detail: `${detail} must pick Claude; got ${JSON.stringify(decision)}` });
        }
      }
      if (!out.criticalThreshold.reason.includes('gemini skipped: no admitted fix path')) {
        violations.push({ invariant: 'gemini-skip-recorded', detail: 'Claude fallback must record why Gemini was skipped' });
      }
      for (const [key, decision] of Object.entries(out)) {
        if (decision.mode !== 'direct') {
          violations.push({ invariant: 'direct-execution', detail: `${key} must execute directly; got ${JSON.stringify(decision)}` });
        }
        if (key.startsWith('critical') && decision.requiresReview !== true) {
          violations.push({ invariant: 'critical-requires-review', detail: `${key} must require review; got ${JSON.stringify(decision)}` });
        }
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
