/** Read-only branch-tip adoption across daemon clones. IO is supplied by the reader. */
import { op } from './registry.mjs';
import { compute } from './step-kinds.mjs';

export const ADOPTION_MATRIX_OP = 'adoption-matrix';

/** Latest timestamp per ref; later lines break ties. Malformed JSONL records are ignored. */
export function parseFixReadyLines(text) {
  const latest = new Map();
  for (const line of String(text ?? '').split('\n')) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (typeof entry?.ref !== 'string' || !entry.ref.trim()) continue;
    const previous = latest.get(entry.ref);
    const at = Date.parse(entry.at);
    if (!previous || !Number.isFinite(Date.parse(previous.at)) || at >= Date.parse(previous.at)) {
      latest.set(entry.ref, { ref: entry.ref, at: entry.at, sha: typeof entry.sha === 'string' ? entry.sha.trim() : '' });
    }
  }
  return [...latest.values()];
}

export function renderAdoptionMatrix({ clones, rows }) {
  const cells = [['BRANCH', ...clones.map(clone => clone.name)],
    ...rows.map(row => [row.ref, ...row.cells])];
  const clean = cells.map(row => row.map(cell => String(cell).replace(/[\r\n\t]/g, ' ')));
  const widths = clean[0].map((_, i) => Math.max(...clean.map(row => row[i].length)));
  return clean.map(row => row.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd()).join('\n');
}

export function adoptionMatrixOperation({ collect } = {}) {
  if (typeof collect !== 'function') throw new TypeError('adoption-matrix needs a collect reader');
  return op(ADOPTION_MATRIX_OP, {
    input: { branches: { type: 'string', required: false, default: '' } },
    verdictFrom: 'read',
    read: compute({ reads: ['input.branches'], fn: ({ input }) => collect({ branches: input.branches }) }),
  });
}

export function finishAdoptionMatrix({ run, code, lines, json = false }) {
  return json || !run?.verdict ? { code, lines } : { code, lines: [renderAdoptionMatrix(run.verdict)] };
}
