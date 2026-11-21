/** Shadow readout only. Existing admission decisions remain authoritative. */
import { op } from './registry.mjs';
import { compute } from './step-kinds.mjs';
export { digestLine } from '../lib/resource-pool.mjs';
export const RESOURCE_POOL_OP = 'resource-pool';
const clean = v => String(v ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
export function renderResourcePool(report) {
  const lines = [`resource pool mode ${report.mode} (configured ${report.configuredMode})${report.unknown ? ' · unknown evidence' : ''}`,
    report.digest, report.settings.provenance, 'sources checked:'];
  for (const s of report.sources) lines.push(`  ${s.source}: ${s.ok ? 'ok' : `UNKNOWN — ${clean(s.error)}`} (${clean(s.description ?? s.source)})`);
  if (report.settings.unknown) lines.push(`  settings: UNKNOWN — ${clean(report.settings.error)}`);
  for (const [resource, totals] of Object.entries(report.summary)) {
    lines.push(`${resource}: ${report.unknown ? '?' : totals.held} held`);
    for (let c = 1; c <= 4; c++) {
      const holders = report.holders.filter(h => h.resource === resource && h.class === c);
      lines.push(`  C${c}: ${report.unknown ? '?' : totals.classes[c]}u`);
      for (const h of holders) lines.push(`    ${clean(h.kind)} ${clean(h.id)} ${h.size}u (${clean(h.source)})`);
    }
  }
  return lines.join('\n');
}
export function resourcePoolOperation({ collect } = {}) {
  if (typeof collect !== 'function') throw new TypeError('resource-pool needs a collect reader');
  return op(RESOURCE_POOL_OP, { input: {}, verdictFrom: 'read',
    read: compute({ reads: [], fn: () => collect() }),
  });
}
/** Only the CLI binds the shadow log sink; collecting a GET never writes evidence. */
export function finishResourcePool({ log } = {}) {
  return ({ run, code, lines, json = false }) => {
    if (run?.verdict && run.verdict.mode !== 'off') {
      try { log?.(run.verdict.rows, { mode: run.verdict.mode }); } catch { /* evidence only */ }
    }
    return json || !run?.verdict ? { code, lines } : { code, lines: [renderResourcePool(run.verdict)] };
  };
}
