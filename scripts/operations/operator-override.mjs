/** Capacity override operations. Host IO is injected by the runner; show only invokes a reader. */
import { op } from './registry.mjs';
import { compute, effect } from './step-kinds.mjs';

export const OPERATOR_OVERRIDE_OPS = Object.freeze(['operator-override-set', 'operator-override-clear', 'operator-override-show']);
export const OPERATOR_OVERRIDE_EFFECT = 'operator-override.write';
export function operatorOverrideOperation(name, { readOverrides = () => ({ readable: true, values: {} }), readEffective = () => ({ effective: [], warnings: [] }) } = {}) {
  if (!OPERATOR_OVERRIDE_OPS.includes(name)) throw Error(`Unknown operator override operation: ${name}`);
  if (name === 'operator-override-show') return op(name, {
    input: { effective: { type: 'boolean', required: false, default: false } }, verdictFrom: 'show', show: compute({ reads: ['input.effective'], fn: ({ input }) => {
      const result = readOverrides();
      if (!result.readable) throw Error('operator-override: unreadable store; repair it before proceeding');
      if (!input.effective) return result;
      return { ...result, ...readEffective(result.values, result.generation) };
    } }),
  });
  const clear = name === 'operator-override-clear';
  return op(name, {
    input: { key: 'string', ...(!clear ? { value: 'number' } : {}), reason: 'string', actor: 'string', 'wait-ms': { type: 'number', required: false, default: 120000 } },
    verdictFrom: 'plan',
    plan: compute({ reads: ['input'], fn: ({ input }) => {
      for (const key of ['reason', 'actor']) if (!input[key]?.trim()) throw Error(`--${key} must be non-empty`);
      const { 'wait-ms': waitMs, ...payload } = input;
      if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 120000) throw Error('--wait-ms must be an integer in 0..120000; use 0 to skip and inspect daemon logs');
      return { ...payload, waitMs, clear };
    } }),
    write: effect({ reads: ['verdict'], effects: view => [{ type: OPERATOR_OVERRIDE_EFFECT,
      idempotent: true, payload: view.verdict }] }),
  });
}

/** Preserve the write exit code; adoption is a separate observation, including in JSON output. */
export function finishOperatorOverride({ run, code, lines, json }) {
  const report = run?.effects?.find(e => e.type === OPERATOR_OVERRIDE_EFFECT && e.status === 'applied')?.result;
  if (!report?.before) return { code, lines };
  if (json) return { code, lines: [JSON.stringify({ ...JSON.parse(lines[0]), effective: report }, null, 2)] };
  const rendered = Object.keys(report.before).flatMap(key => [...new Set([
    ...Object.keys(report.before[key]), ...Object.keys(report.after[key]),
  ])].map(daemon => `${key} · ${daemon}: before ${JSON.stringify(report.before[key][daemon] ?? null)}; after ${JSON.stringify(report.after[key][daemon] ?? null)}`));
  return { code, lines: [...lines, `daemon observation: ${report.observation}`, ...rendered,
    ...report.pending, ...report.warnings.map(w => `warning: ${w}`)].map(l => String(l).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')) };
}
