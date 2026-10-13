#!/usr/bin/env node
/** Read-only report: never changes settings or mergeGate.reviewAuthority; always exits zero. */
import { readSettings } from './lib/settings-files.mjs';
import { readShadowRuns, resolvePromotionSettings, formatPromotionSettings, measureReadiness, reclassifyRow, projectDrainFactsRow, drainFactHoldCodes, formatReadinessLine } from './lib/ledger-promotion-readiness.mjs';

try {
  const args = process.argv.slice(2);
  const override = args.find(a => a.startsWith('--window-days='));
  const env = { ...process.env, ...(override ? { WE_LEDGER_PROMOTION_WINDOW_DAYS: override.split('=')[1] } : {}) };
  const settingsResult = resolvePromotionSettings({ repo: readSettings(), env });
  const { runs, corrupt } = readShadowRuns();
  const measure = measureReadiness(runs, { settings: settingsResult.settings });
  const replay = () => {
    const count = (stage) => {
      const c = { agree: 0, disagree: 0, transient: 0, unreadable: 0 };
      const remainingByCode = {};
      for (const run of runs) for (const stored of run.findings?.rows ?? []) {
        const raw = { ...stored, schema: run.input?.schema ?? stored.schema };
        const classified = stage === 'before' ? raw : reclassifyRow(raw);
        const row = stage === 'projected' ? projectDrainFactsRow(classified) : classified;
        const status = row.status;
        if (stage === 'projected' && status === 'disagree') {
          const holds = drainFactHoldCodes(row);
          const codes = row.direction === 'ledger-holds-label-clears'
            ? holds?.filter(code => code !== 'no-ledger-row' && code !== 'stale-acceptance'
              && !(typeof code === 'string' && code.startsWith('hold:drain:'))) : holds;
          for (const code of codes?.length ? codes : [row.reason || 'unknown']) {
            remainingByCode[code] = (remainingByCode[code] ?? 0) + 1;
          }
        }
        c[Object.hasOwn(c, status) ? status : 'unreadable']++;
      }
      const n = c.agree + c.disagree + c.unreadable;
      return { ...c, agreementPct: n ? c.agree / n * 100 : 0, ...(stage === 'projected' ? { remainingByCode } : {}) };
    };
    return { before: count('before'), after: count('after'), projected: count('projected') };
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
      if (c.remainingByCode) for (const [code, n] of Object.entries(c.remainingByCode)) console.log(`  ${n} × ${code}`);
    }
  }
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
}
