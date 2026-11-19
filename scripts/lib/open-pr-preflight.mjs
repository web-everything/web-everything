/** Pure presentation and composition of open-pr admission evidence. */
const verify = 'run verify-lane';
const audit = 'run node scripts/operations/run.mjs codex-audit --base=origin/main --head=<fullsha>; if WEAKENED needs a waiver request for sha X';
export const HINTS = Object.freeze({
  'canonical-audit-missing': audit, 'canonical-audit-weakened': audit,
  unverified: verify, untracked: verify, 'verify-unfinished': verify,
  'verify-red': verify, 'verify-corrupt': verify, 'red-ci-gated': verify,
  'soak-declaration': 'needs a soak break under scripts/conveyor/soak/breaks/ (module + .soak.test.mjs) or a body waiver',
  'prep-block-missing': 'PREP block expects plain `Acceptance:` lines',
  'pre-pr-review-missing': 'run pre-pr-review for the full head sha',
  'pr-limit': 're-run once the count drops, or use an authorized pr-limit override',
  'empty-body': 'pass --body-file with a non-empty PR description',
  'closing-keyword-body': 'replace fixes/closes/resolves #N with card N or PR N',
  'locus-prefix': 'prefix code paths with their repository locus (for example we:scripts/)',
  'fix-claimed': 'wait for the live claim holder to finish with fix-end',
});

export function blocker(gate, reason, detail, sha) {
  return { gate, reason, detail: detail || reason,
    hint: (HINTS[reason] || `resolve ${gate}: ${detail || reason}`)
      .replace('<fullsha>', sha || '<fullsha>').replace('sha X', `sha ${sha || 'X'}`) };
}

/** First evidence wins; a runner and its child may report the same gate. */
export function mergeBlockers(...groups) {
  const seen = new Set();
  return groups.flat().filter(b => {
    if (!b) return false;
    const key = `${b.gate}\0${b.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function formatBlockers(blockers) {
  const clean = value => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
  return blockers.map(b => `- ${clean(b.gate)} (${clean(b.reason)}): ${clean(b.detail)} — fix: ${clean(b.hint || HINTS[b.reason] || 'resolve this gate and re-run --check')}`).join('\n');
}
