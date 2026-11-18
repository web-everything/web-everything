/** @file Explicit-path, dry-by-default R1047 waiver migration. */
import * as realFs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { evaluateAuditFile } from '../lib/audit-ledger.mjs';

export function backfillWaivers({ prefsPath, ledgerPath, apply = false, fs = realFs }) {
  const original = fs.readFileSync(prefsPath, 'utf8'), prefs = JSON.parse(original);
  const records = fs.readFileSync(ledgerPath, 'utf8').split('\n').flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const genesis = records.findLastIndex(r => r?.kind === 'genesis');
  const report = { matched: [], unmatched: [], applied: false };
  for (const w of prefs.prototypeLoad?.ruledWeakened ?? []) {
    if (w.auditId) continue;
    const candidates = records.slice(genesis + 1).filter(r => genesis >= 0 && r?.verdict === 'WEAKENED'
      && typeof r.id === 'string' && r.head === w.sha && (r.ref ?? r.branch ?? r.headRef) === w.ref
      && JSON.stringify(r.findings) === JSON.stringify(w.findings));
    const match = candidates.findLast(r => evaluateAuditFile({ ledgerPath, fs, head: r.head,
      liveFp: r.fingerprint, lookup: true }).record?.id === r.id);
    if (match) { w.auditId = match.id; report.matched.push({ ref: w.ref, auditId: match.id }); }
    else report.unmatched.push({ ref: w.ref, sha: w.sha });
  }
  if (apply && report.matched.length) { fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2) + '\n'); report.applied = true; }
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), flags = {};
    for (const arg of args) {
      const m = /^--(prefs|ledger)=(.+)$/.exec(arg);
      if (arg === '--apply') flags.apply = true;
      else if (m && !flags[m[1] + 'Path']) flags[m[1] + 'Path'] = m[2];
      else throw new Error('usage: audit-ledger-waiver-backfill.mjs --prefs=<path> --ledger=<path> [--apply]');
    }
    if (!flags.prefsPath || !flags.ledgerPath) throw new Error('Explicit --prefs and --ledger paths required');
    console.log(JSON.stringify(backfillWaivers(flags)));
  } catch { console.error('Backfill failed; check explicit paths and readable JSON evidence, then retry.'); process.exitCode = 2; }
}
