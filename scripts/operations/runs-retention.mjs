/**
 * @file scripts/operations/runs-retention.mjs
 * @description THE `runs-retention` DECLARATION (R549): archive-then-delete terminal run records older than
 *   `runs.retention.keepDays`. Dry-run by default; `--apply` archives (verified read-back) and then deletes.
 *   Logic lives in `./runs-retention-core.mjs`; settings in `scripts/settings/runs-retention.json`.
 */
import { op } from './registry.mjs';
import { effect as effectStep, compute } from './step-kinds.mjs';
import { DECLARED_HOMES } from './declared-homes.mjs';

export const RUNS_RETENTION_OP = 'runs-retention';
export const RUNS_RETENTION_EFFECT = 'runs-retention.run';

export function runsRetentionOperation() {
  return op(RUNS_RETENTION_OP, {
    declaresOver: DECLARED_HOMES['runs-retention'],
    input: {
      apply: { type: 'boolean', required: false, default: false },
      month: { type: 'string', required: false, default: '' },
    },
    verdictFrom: 'plan',
    plan: compute({
      reads: ['input.apply', 'input.month'],
      fn: (view) => ({ apply: view.input.apply === true, month: String(view.input.month || '') }),
    }),
    run: effectStep({
      reads: ['verdict'],
      effects: (view) => [{
        type: RUNS_RETENTION_EFFECT,
        idempotent: true,
        payload: { dryRun: !view.verdict.apply, month: view.verdict.month },
      }],
    }),
  });
}

export function finishRunsRetention({ run, code, lines, json = false } = {}) {
  if (json) return { code, lines };
  const effect = (run?.effects ?? []).find(e => e.type === RUNS_RETENTION_EFFECT);
  const r = effect?.result;
  if (!r) return { code: 1, lines: [`runs-retention: FAILED${effect?.error ? ` — ${String(effect.error).split('\n')[0]}` : ''}`] };
  const mb = n => `${(n / 1048576).toFixed(1)} MiB`;
  const out = [
    `runs-retention: ${r.status}${r.dryRun ? ' (dry run; --apply to archive+delete)' : ''}`,
    `runs-retention: scanned ${r.scanned}, eligible ${r.eligible} (${mb(r.eligibleBytes)}), months ${JSON.stringify(r.months)}`,
    `runs-retention: kept young ${r.kept.young}, non-terminal ${r.kept.nonTerminal}, resumable ${r.kept.resumable}, unreadable ${r.kept.unreadable}`,
  ];
  if (!r.dryRun) out.push(`runs-retention: archived ${r.archived}, deleted ${r.deleted}, freed ${mb(r.bytesFreed)}; archives ${r.archives.join(', ') || '(none)'}`);
  for (const e of r.errors) out.push(`runs-retention: ERROR ${e}`);
  return { code: r.errors.length ? 1 : code, lines: out };
}
