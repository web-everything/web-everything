/**
 * @file breaks/codex-unproductive-jumps-to-claude.mjs — live break 2026-10-14: 22 repairs jumped from
 * two unproductive Codex runs straight to Claude (including PRs #5294, #5281, #5237), as did five
 * stronger-model fixes. The fallback chain must try codex-alt first without weakening the critical-work gate.
 *
 * SCENARIO: route an ordinary fix with two unproductive Codex runs on its head, a round-3 ordinary fix
 * with none, and a critical fix with two. RED = either ordinary fix picks Claude; GREEN = both pick
 * codex-alt, while critical escalation still picks Claude.
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
const out = {
  unproductive: routeFixExecutor(planned, options),
  strongerModel: routeFixExecutor({ ...planned, pr: 5281, round: 3 }, options),
  critical: routeFixExecutor(planned, { ...options, criticalFor: () => true }),
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
      ]) {
        const decision = out[key];
        if (decision.executor !== 'codex' || decision.rung !== 'codex-alt') {
          violations.push({ invariant, detail: `${detail} must pick codex-alt before Claude; got ${JSON.stringify(decision)}` });
        }
      }
      if (out.critical.executor !== 'claude') {
        violations.push({ invariant: 'critical-stays-claude', detail: `critical work with two unproductive Codex runs must still pick Claude; got ${JSON.stringify(out.critical)}` });
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
