/** Routine settings-bearing pass rows must not exhaust the lifetime action-evidence budget. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const SOURCE = 'scripts/conveyor/pr-stall-sweep.mjs';

export default {
  id: 'stall-sweep-pass-history-exhaustion',
  title: 'routine pass growth remains readable while lifetime spends and corrupt-row holds survive',
  card: 'BLD-8039 / PR #7550',
  fixedBy: { sha: 'HEAD', where: 'lane/bld-8039', paths: [SOURCE] },
  fixPresent(root) {
    return readFileSync(join(root, SOURCE), 'utf8').includes('const AUDIT_READ_CHUNK_BYTES');
  },
  async run({ sourceRoot = ROOT } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'soak-stall-audit-'));
    const violations = [];
    try {
      const { readAuditHistory, runStallSweep, planStallActions, STALL_SWEEP_DEFAULTS } = await import(pathToFileURL(join(sourceRoot, SOURCE)).href);
      const now = Date.parse('2026-11-26T18:00:00Z'), ts = new Date(now - 3 * 3600_000).toISOString();
      const repo = 'example/project', pr = 11, head = 'a'.repeat(40), prHead = `${repo}#${pr}@${head}`;
      const receipt = { ts, phase: 'intent', action: 'tooling-card', prHead, key: `${prHead}:original` };
      const pass = JSON.stringify({ ts, phase: 'pass', settings: { padding: 'x'.repeat(2048) } }) + '\n';
      writeFileSync(join(dir, '2026-10.jsonl'), JSON.stringify(receipt) + '\n' + pass.repeat(4096));
      const history = readAuditHistory(dir);
      if (!history.complete || history.records.length !== 1 || history.records[0].key !== receipt.key)
        violations.push('more than 8 MiB of routine pass rows must preserve complete lifetime evidence');
      const item = { repo, pr, head, prHead, lane: 'system', action: 'tooling-card', key: `${prHead}:new` };
      const plan = planStallActions([item], { history: history.records, now,
        limits: { ...STALL_SWEEP_DEFAULTS, maxActionsPerPrHead: 1 } });
      if (plan.act.length || !plan.held.some(row => row.held === 'per-PR-head cap'))
        violations.push('the old-month lifetime spend must still hold a new action after streaming pass rows');
      const settings = { value: { ...STALL_SWEEP_DEFAULTS, mode: 'shadow' }, sources: { mode: 'soak' }, errors: [] };
      let effects = 0;
      const sweep = () => runStallSweep({ now, dir, env: {}, settings, force: true, log: () => {},
        read: () => ({ now, unreadable: [], liveJobs: [], drainSkips: [], prs: [] }),
        gh: () => { throw new Error('unexpected network request'); },
        dispatchRestart: () => { effects++; throw new Error('unexpected restart'); } });
      if ((await sweep()).incomplete) violations.push('routine pass growth must not block a scheduled pass');
      writeFileSync(join(dir, '2026-11.jsonl'), '\n{torn\n');
      const corrupt = await sweep();
      if (!corrupt.incomplete || corrupt.act.length || !corrupt.errors.some(e => e.includes('2026-11.jsonl:2: invalid JSON')))
        violations.push('corruption after the large historical month must fail closed at its physical line');
      if (effects) violations.push('the scenario must never dispatch work');
      return { violations };
    } catch (error) { return { violations: [...violations, error.message] }; }
    finally { rmSync(dir, { recursive: true, force: true }); }
  },
  judge: report => report.violations,
};
