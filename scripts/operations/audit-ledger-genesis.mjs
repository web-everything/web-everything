/** @file Explicit, dry-by-default migration; the apply path re-reads under the writer lock. */
import * as realFs from 'node:fs';
import { appendChained, buildGenesis, readLedger } from '../lib/audit-ledger-chain.mjs';
import { auditRecordPath } from './codex-audit-io.mjs';

export function createGenesisRunner({ fs = realFs, path } = {}) {
  return async ({ apply = false } = {}) => {
    const ledgerPath = path ?? auditRecordPath({ fs });
    const raw = readLedger(ledgerPath, fs), genesis = buildGenesis(raw);
    const existing = genesis ?? raw.toString('utf8').split('\n').flatMap(line => {
      try { const entry = JSON.parse(line); return entry?.kind === 'genesis' ? [entry] : []; } catch { return []; }
    })[0];
    const appended = apply && genesis ? await appendChained(ledgerPath, { kind: 'genesis' }, { fs }) : null;
    const report = appended ?? existing;
    return { legacyCount: report.legacyCount, legacyDigest: report.legacyDigest,
      genesisExists: genesis === null || apply, wouldAppend: genesis !== null,
      applied: appended !== null };
  };
}

/** Recovery path (orchestrator-only, logged with actor and reason): anchors the current bytes under a new genesis. */
export function createResealRunner({ fs = realFs, path } = {}) {
  return async ({ apply = false, actor, reason } = {}) => {
    if (typeof actor !== 'string' || !actor.trim() || typeof reason !== 'string' || !reason.trim()) throw new Error('audit-ledger-reseal requires actor and reason');
    const ledgerPath = path ?? auditRecordPath({ fs }), raw = readLedger(ledgerPath, fs);
    const preview = buildGenesis(raw, { reseal: true });
    const appended = apply ? await appendChained(ledgerPath, { kind: 'genesis', reseal: true, actor, reason }, { fs }) : null;
    return { actor, reason, legacyCount: (appended ?? preview).legacyCount, legacyDigest: (appended ?? preview).legacyDigest, applied: appended !== null };
  };
}
