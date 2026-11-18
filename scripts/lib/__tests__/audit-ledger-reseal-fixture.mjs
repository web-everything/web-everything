/** Test stand-in for the orchestrator's out-of-repo reseal script: a raw genesis append under the ledger lock (the library has no reseal path). */
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { newId, sha256Line, withLedgerLock } from '../audit-ledger-chain.mjs';

export function genesisLine(raw, extra = {}) {
  const separator = raw.length && raw.at(-1) !== 10 ? '\n' : '', anchored = Buffer.concat([Buffer.from(raw), Buffer.from(separator)]);
  const lines = anchored.toString('utf8').split('\n').filter(line => line.trim());
  return { separator, record: { kind: 'genesis', seq: 0, id: newId(), legacyCount: lines.length, legacyDigest: sha256Line(anchored),
    prev: lines.length ? sha256Line(lines.at(-1)) : null, at: new Date().toISOString(), reseal: true, ...extra } };
}
export function resealLedger(path, extra = { actor: 'test', reason: 'repair' }) {
  return withLedgerLock(path, () => {
    const { separator, record } = genesisLine(fs.existsSync(path) ? fs.readFileSync(path) : Buffer.alloc(0), extra), line = JSON.stringify(record);
    fs.appendFileSync(path, `${separator}${line}\n`);
    fs.writeFileSync(join(dirname(path), 'audits.hwm.json'), JSON.stringify({ seq: 0, lineHash: sha256Line(line) }));
    return record;
  });
}
