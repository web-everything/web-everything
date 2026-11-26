import { collapseRollupToLatestPerName } from '../lib/rollup-collapse.mjs';

/** Ordered CI-heal admission; annotations describe evidence without changing check truth. */
export function admitCiHeal({ reason, failingRequired = [], rollup = [], codeqlFailure, mainState = 'unknown' } = {}) {
  const refuse = (reason, why) => ({ admitted: false, reason, why });
  const admit = (classes, basis = 'real') => ({ admitted: true, classes, basis });
  if (reason === 'codeql') return codeqlFailure ? admit(['real'])
    : refuse('no-failing-check', 'No observed CodeQL failure authorizes CI repair');
  if (!failingRequired.length) return refuse('no-failing-check', 'No failing required check authorizes CI repair');
  const rows = collapseRollupToLatestPerName(rollup);
  const classes = [...new Set(failingRequired.map(name => {
    if (name === 'review-gate') return 'review';
    if (name !== 'merge-gate') return 'real';
    const cls = rows.find(row => row.name === name)?.mergeGateAdmission?.class;
    return ['real', 'main', 'review'].includes(cls) ? cls : 'unreadable';
  }))];
  if (classes.includes('real')) return admit(classes);
  if (classes.includes('main')) return mainState === 'green' ? admit(classes, 'main-green')
    : refuse('main-red', 'Main is red or unknown; main-only holds cannot authorize CI repair');
  if (classes.includes('unreadable')) return refuse('x-merge-gate-unreadable', 'Merge-gate evidence is unreadable; a person must inspect the verdict');
  return refuse('review-hold', 'Only review-owned holds remain');
}
