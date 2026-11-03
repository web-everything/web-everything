/** Pure audit projection of platform-decisions#review-stringency-classified-outcomes. */
import { BUILT_IN_REVIEW_SETTINGS, RELEASE_STAGES } from '../lib/review-settings.mjs';

export const FINDING_CLASSES = Object.freeze(['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'E1', 'E2', 'D1', 'D2', 'D3', 'X1', 'X2']);
const scopeKeys = ['file', 'line', 'invariant', 'trigger', 'consequence', 'relation'];
const text = value => typeof value === 'string' && value.trim().length > 0;
export const findingIdentity = f => JSON.stringify([f?.file, f?.invariant]);
const validInterleaving = steps => Array.isArray(steps) && steps.length >= 2 && steps.length <= 32
  && steps.every(step => step && typeof step === 'object' && !Array.isArray(step)
    && ['actor', 'action'].every(k => text(step[k]) && step[k].length <= 1024))
  && new Set(steps.map(step => step.actor.trim())).size >= 2;
export function validFinding(f) {
  return f !== null && typeof f === 'object' && !Array.isArray(f)
    && FINDING_CLASSES.includes(f.class) && ['id', 'file', 'invariant', 'consequence'].every(k => text(f[k]))
    && Number.isSafeInteger(f.line) && f.line > 0
    && (text(f.trigger) || (f.class === 'D1' && Object.hasOwn(f, 'trigger') && (f.trigger === null || f.trigger === '')))
    && ['introduced', 'newly relied on', 'untouched'].includes(f.relation)
    && (!Object.hasOwn(f, 'interleaving') || validInterleaving(f.interleaving));
}

// Bounded literal globs: * matches a segment, ** spans directories; a trailing / is a prefix.
function matchesPath(file, pattern) {
  if (pattern.endsWith('/')) return file.startsWith(pattern);
  const source = pattern.split(/(\*\*|\*)/).map(part => part === '**' ? '.*' : part === '*' ? '[^/]*'
    : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
  return new RegExp(`^${source}$`).test(file);
}

export function computeVerdict(findings, options = {}) {
  const { releaseStage = 'prerelease', raceBlockPaths = BUILT_IN_REVIEW_SETTINGS.raceBlockPaths, rulings = [] } = options;
  const result = { verdict: 'NOT WEAKENED', blocks: [], ships: [], cards: [], recheck: [] };
  if (!Array.isArray(findings) || !RELEASE_STAGES.includes(releaseStage)
    || !Array.isArray(raceBlockPaths) || raceBlockPaths.length > 256
    || !raceBlockPaths.every(p => text(p) && p.length <= 512) || !Array.isArray(rulings)) {
    result.blocks.push({ class: 'X2', consequence: 'Invalid audit input/settings; request human adjudication' });
  } else for (const input of findings) {
    const f = { ...input };
    if (!validFinding(input)) { result.blocks.push(f); continue; }
    // Only authenticated adapter-supplied rulings confer authority, never model-supplied scope.
    const ruling = rulings.find(r => r && r.id === f.ruling && text(r.id)
      && scopeKeys.every(k => r.scope?.[k] === f[k]));
    if (f.class === 'X1' && ruling) f.class = 'X1';
    else {
      // A failed exemption proves no underlying defect class. Keep it unresolved
      // until the targeted recheck independently classifies the evidence.
      if (f.class === 'X1') {
        result.recheck.push({ ...f, class: 'X2' });
        continue;
      }
      const protectedPath = [...BUILT_IN_REVIEW_SETTINGS.raceBlockPaths, ...raceBlockPaths].some(p => matchesPath(f.file, p));
      if (protectedPath && !f.class.startsWith('B')) {
        if (validInterleaving(f.interleaving)) f.class = 'B4';
        else if (f.class !== 'D1') f.class = 'X2';
      }
    }
    if (f.class === 'D1' || f.class === 'X2') { result.recheck.push(f); continue; }
    if (f.class.startsWith('B') || (releaseStage === 'prod' && f.class.startsWith('E'))
      || (f.class === 'D2' && f.relation !== 'untouched')) { result.blocks.push(f); continue; }
    result.ships.push(f);
    result.cards.push({ ...f, ...(f.class === 'E1' ? { outcome: 'expedite', deadlineHours: 72 }
      : f.class === 'D2' ? { outcome: 'debt', mustPayBefore: 'prod', mustExistOnMain: true }
        : f.class === 'E2' ? { outcome: 'debt' }
          : f.class === 'X1' ? { outcome: 'accepted-risk' } : { outcome: 'advisory' }) });
  }
  if (result.blocks.length || result.recheck.length) result.verdict = 'WEAKENED';
  return result;
}
