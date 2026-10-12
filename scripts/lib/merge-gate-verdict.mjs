/** Lightweight job-log contract: operator readers must not import the drain's runtime graph. */
import { GATE_IDS } from './merge-gate-inventory.mjs';

const STATUS_WIDTH = 17;
const ID_WIDTH = 22;
export const VERDICT_STATUSES = Object.freeze(['pass', 'hold', 'fail-closed', 'queue', 'enqueue', 'skipped-by-policy']);

/** Human-readable check summary. */
export function formatPrResult(p) {
  const lines = [`#${p.num}: ${p.ok ? 'PASS' : 'HOLD'}`];
  for (const x of p.results) lines.push(`  ${x.status.padEnd(STATUS_WIDTH)} ${x.id.padEnd(ID_WIDTH)} ${x.reason}`);
  return lines.join('\n');
}

/** Read the last verdict for this PR, never an earlier successful attempt. Pure. */
export function parsePrResultTable(logText, num) {
  const lines = String(logText ?? '').split(/\r?\n/)
    .map((line) => line.replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z /, ''));
  const index = lines.findLastIndex((line) => line === `#${num}: PASS` || line === `#${num}: HOLD`);
  if (index < 0) return { error: `no verdict header for #${num}` };
  const ok = lines[index] === `#${num}: PASS`;
  const results = [];
  const seen = new Set();
  const row = new RegExp(`^  (.{${STATUS_WIDTH}}) (\\S+) (.*)$`);
  for (const line of lines.slice(index + 1)) {
    const match = row.exec(line);
    if (!match) break;
    const status = match[1].trim();
    const id = match[2];
    if (!VERDICT_STATUSES.includes(status)) return { error: `unknown status: ${status}` };
    if (!GATE_IDS.includes(id)) return { error: `unknown gate: ${id}` };
    if (seen.has(id)) return { error: `duplicate gate: ${id}` };
    seen.add(id);
    const padding = Math.max(0, ID_WIDTH - id.length);
    if (!match[3].startsWith(' '.repeat(padding))) return { error: `invalid gate padding: ${id}` };
    results.push({ id, status, reason: match[3].slice(padding) });
  }
  if (!results.length) return { error: `no verdict rows for #${num}` };
  // A readable prefix cannot prove that later, non-human gates did not block.
  const missing = GATE_IDS.filter((id) => !seen.has(id));
  if (missing.length) return { error: `incomplete verdict for #${num}: missing gates: ${missing.join(', ')}` };
  const blocked = results.some(({ status }) => status === 'hold' || status === 'fail-closed');
  if (ok === blocked) return { error: 'verdict header disagrees with blocking rows' };
  return { num, ok, results };
}

/**
 * Human clearance removes these holds itself: candidate-label loses ready-to-merge whenever a review hold
 * applies (review-escalation.mjs #2832); producer-certified accepts review:accepted as certification.
 * review-hold-labels/review-acceptance are the human hold. test-gaming requires human clearance at the head
 * (shouldReparkForTestTampering). Under labels authority, ledger holds exactly while the review labels hold.
 */
export const HUMAN_REVIEW_HOLD_GATES = Object.freeze([
  'candidate-label', 'producer-certified', 'review-hold-labels', 'review-acceptance', 'test-gaming', 'ledger',
]);

/** Excuse only actual human holds; unreadable inputs remain blocking even on those same gates. Pure. */
export function humanReviewOnlyHold(results) {
  const holds = [];
  const others = [];
  for (const { id, status } of results) {
    if (status !== 'hold' && status !== 'fail-closed') continue;
    if (status === 'hold' && HUMAN_REVIEW_HOLD_GATES.includes(id)) holds.push(id);
    else others.push({ id, status });
  }
  return { only: others.length === 0 && holds.some((id) => id === 'review-hold-labels' || id === 'review-acceptance'),
    holds, others };
}
