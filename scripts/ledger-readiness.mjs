#!/usr/bin/env node
/** Read-only report: never changes settings or mergeGate.reviewAuthority; always exits zero. */
import { readSettings } from './lib/settings-files.mjs';
import { readShadowRuns, resolvePromotionSettings, formatPromotionSettings, measureReadiness, reclassifyRow, formatReadinessLine } from './lib/ledger-promotion-readiness.mjs';

try {
  const args = process.argv.slice(2);
  const override = args.find(a => a.startsWith('--window-days='));
  const env = { ...process.env, ...(override ? { WE_LEDGER_PROMOTION_WINDOW_DAYS: override.split('=')[1] } : {}) };
  const settingsResult = resolvePromotionSettings({ repo: readSettings(), env });
  const { runs, corrupt } = readShadowRuns();
  const measure = measureReadiness(runs, { settings: settingsResult.settings });
  const replay = () => {
    const count = (after) => {
      const c = { agree: 0, disagree: 0, transient: 0, unreadable: 0 };
      for (const run of runs) for (const stored of run.findings?.rows ?? []) {
        const row = { ...stored, schema: run.input?.schema ?? stored.schema };
        const status = (after ? reclassifyRow(row) : row).status;
        c[Object.hasOwn(c, status) ? status : 'unreadable']++;
      }
      const n = c.agree + c.disagree + c.unreadable;
      return { ...c, agreementPct: n ? c.agree / n * 100 : 0 };
    };
    return { before: count(false), after: count(true) };
  };
  if (args.includes('--json')) console.log(JSON.stringify(args.includes('--replay') ? { ...measure, replay: replay() } : measure, null, 2));
  else {
    console.log(`ledger promotion settings · ${formatPromotionSettings(settingsResult)}`);
    console.log(formatReadinessLine(measure, settingsResult));
    for (const c of measure.checks) console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}: ${c.value} (threshold ${c.threshold})`);
    for (const { reason, n } of measure.topDisagreeReasons.slice(0, 5)) console.log(`  ${n} × ${reason}`);
    if (corrupt) console.log(`  skipped corrupt records: ${corrupt}`);
    if (args.includes('--replay')) for (const [label, c] of Object.entries(replay())) {
      console.log(`${label}: agree ${c.agree} · disagree ${c.disagree} · transient ${c.transient} · unreadable ${c.unreadable} · agreement ${c.agreementPct.toFixed(1)}%`);
    }
  }
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
}
