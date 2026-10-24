/** Read-only branch-tip adoption across daemon clones. IO is supplied by the reader. */
import { op } from './registry.mjs';
import { compute } from './step-kinds.mjs';

export const ADOPTION_MATRIX_OP = 'adoption-matrix';
export const MAX_ADOPTION_REFS = 50;

/** Latest timestamp per ref, retaining at most the 50 most recent refs; later lines break ties. */
export function parseFixReadyLines(text, { onTruncated = () => {} } = {}) {
  const latest = new Map();
  for (const line of String(text ?? '').split('\n')) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (typeof entry?.ref !== 'string' || !entry.ref.trim()) continue;
    const previous = latest.get(entry.ref);
    const at = Date.parse(entry.at);
    if (!previous || !Number.isFinite(Date.parse(previous.at)) || at >= Date.parse(previous.at)) {
      latest.set(entry.ref, { ref: entry.ref, at: entry.at, sha: typeof entry.sha === 'string' ? entry.sha : '' });
    }
    if (latest.size > MAX_ADOPTION_REFS) {
      let oldest;
      for (const entry of latest.values()) {
        if (!oldest || (Date.parse(entry.at) || 0) < (Date.parse(oldest.at) || 0)) oldest = entry;
      }
      latest.delete(oldest.ref);
      onTruncated();
    }
  }
  return [...latest.values()];
}

export function renderAdoptionMatrix({ clones, rows, incomplete = [], truncated = false }) {
  const cells = [['BRANCH', ...clones.map(clone => clone.name)],
    ...rows.map(row => [row.ref, ...row.cells])];
  const clean = cells.map(row => row.map(cell => String(cell).replace(/[\p{Cc}\p{Cf}]/gu, '')));
  const widths = clean[0].map(() => 0);
  for (const row of clean) row.forEach((cell, i) => { widths[i] = Math.max(widths[i], cell.length); });
  const warning = incomplete.length || truncated
    ? '\nINCOMPLETE: ' + [...incomplete, ...(truncated ? ['truncated'] : [])].join('; ')
      + ' — inspect source evidence and retry with explicit branches/clones in smaller batches.' : '';
  return clean.map(row => row.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd()).join('\n') + warning;
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
