/** @file Explicit, dry-by-default migration; the apply path re-reads under the writer lock. */
import * as realFs from 'node:fs';
import { appendGenesis, buildGenesis, readLedger } from '../lib/audit-ledger-chain.mjs';
import { auditRecordPath } from './codex-audit-io.mjs';

export function createGenesisRunner({ fs = realFs, path } = {}) {
  return async ({ apply = false } = {}) => {
    const ledgerPath = path ?? auditRecordPath({ fs });
    const raw = readLedger(ledgerPath, fs), genesis = buildGenesis(raw);
    const existing = genesis ?? raw.toString('utf8').split('\n').flatMap(line => {
      try { const entry = JSON.parse(line); return entry?.kind === 'genesis' ? [entry] : []; } catch { return []; }
    })[0];
    const appended = apply && genesis ? await appendGenesis(ledgerPath, { fs }) : null;
    const report = appended ?? existing;
    return { legacyCount: report.legacyCount, legacyDigest: report.legacyDigest,
      genesisExists: genesis === null || apply, wouldAppend: genesis !== null,
      applied: appended !== null };
  };
}
