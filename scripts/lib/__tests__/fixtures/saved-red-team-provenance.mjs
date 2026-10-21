import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newRunRecord, writeRun } from '../../../operations/run-store.mjs';
import { reviewPrOperation } from '../../../operations/review-pr.mjs';
import { resolveScorecardStorePath } from '../../../conveyor/run-scorecard-store.mjs';

// Phase A wire contract for the future review-job writer and saved-result reader:
// run.findings.savedRedTeamResult = { writer, references: [{ path, index }], sha256 }.
// Hash the JSON-persisted rows as one array, recursively sorting object keys; array order is significant.
// Keep this independent of production hashing so a shared hashing bug cannot validate itself.
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const savedRowsHash = rows => createHash('sha256')
  .update(JSON.stringify(canonical(JSON.parse(JSON.stringify(rows))))).digest('hex');

export function provenanceRun({ env, rows, indexes = rows.map((_, i) => i), id = 'review-pr-provenance',
  repo = rows[0]?.repo, pr = rows[0]?.pr, head = rows[0]?.rev } = {}) {
  const run = newRunRecord({ id, op: 'review-pr', input: { repo, pr } });
  return { ...run, cursor: reviewPrOperation({ readPr: () => { throw new Error('fixture never reads GitHub'); } }).steps.length,
    verdict: { verdict: 'accept' }, findings: {
      read: { repo, pr, netBasis: { rev: head }, netChangedFiles: ['scripts/example.mjs'] },
      savedRedTeamResult: { writer: 'review-job',
        references: indexes.map(index => ({ path: resolveScorecardStorePath(env), index })),
        sha256: savedRowsHash(indexes.map(index => rows[index])) },
    } };
}

// Add provenance to existing fixtures without changing their rows or assertions.
export function saveProvenanceFixtures(env) {
  const rows = JSON.parse(readFileSync(resolveScorecardStorePath(env), 'utf8')).records;
  rows.forEach((row, index) => writeRun(provenanceRun({ env, rows, indexes: [index],
    id: `review-pr-provenance-${index}`, repo: row.repo, pr: row.pr, head: row.rev }),
  env.WE_SHARED_RUNS_DIR ?? join(env.CONVEYOR_STATE_ROOT, 'runs')));
}
