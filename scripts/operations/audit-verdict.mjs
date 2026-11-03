/** Pure audit projection of platform-decisions#review-stringency-classified-outcomes. */
import { BUILT_IN_REVIEW_SETTINGS, RELEASE_STAGES } from '../lib/review-settings.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL as NodeURL } from 'node:url';

export const FINDING_CLASSES = Object.freeze(['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'E1', 'E2', 'D1', 'D2', 'D3', 'X1', 'X2']);
const scopeKeys = ['file', 'line', 'invariant', 'trigger', 'consequence', 'relation'];
const text = value => typeof value === 'string' && value.trim().length > 0;
export const findingIdentity = f => JSON.stringify([f?.file, f?.invariant]);
/**
 * Full re-check binding: a re-check may keep or downgrade the SAME fingerprint, never another finding.
 * Binds the location (file, line, hunk), the claim (invariant, trigger, consequence) and its class/relation;
 * only the D1 to D3 downgrade may restate the trigger (see `sameFindingRecheck`).
 */
export const findingFingerprint = f => JSON.stringify([f?.id, f?.file, f?.line, f?.invariant, f?.trigger ?? null,
  f?.consequence, f?.class, f?.relation, f?.hunkHash ?? null]);
/** True when `checked` keeps `original`'s fingerprint, or is its D1 to D3 downgrade differing only in the trigger. */
export const sameFindingRecheck = (original, checked) => findingFingerprint(checked) === findingFingerprint(original)
  || (original?.class === 'D1' && checked?.class === 'D3'
    && findingFingerprint({ ...checked, class: 'D1', trigger: original.trigger }) === findingFingerprint(original));
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

const REPO_ROOT = fileURLToPath(new NodeURL('../../', import.meta.url));
const CARD_PATH = /^backlog\/[A-Za-z0-9._-]+\.md$/;
/** Default card reader: the card must exist on origin/main. Any failure is unavailable (null). */
export function readCardFromMain(path) {
  if (typeof path !== 'string' || !CARD_PATH.test(path)) return null;
  const r = spawnSync('git', ['show', `origin/main:${path}`], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000, maxBuffer: 1 << 20 });
  return r.error || r.status !== 0 ? null : r.stdout;
}
/**
 * D2 debt ships only when its card exists on main and the card's pay-by has not passed. The pay-by is read
 * only from that card, never from the model-supplied finding. A card without one owes `prod`, and a `prod`
 * pay-by is due at the prod stage. Unreadable, conflicting or unparseable => false.
 */
function d2Verified(f, { readCard = readCardFromMain, now = Date.now } = {}, releaseStage) {
  try {
    if (typeof f.card !== 'string' || !CARD_PATH.test(f.card)) return false;
    const body = readCard(f.card);
    if (typeof body !== 'string' || !body.trim()) return false;
    const dues = new Set([...body.matchAll(/^mustPayBefore:\s*(\S+)\s*$/gm)].map(m => m[1]));
    if (dues.size > 1) return false;
    const due = dues.size ? [...dues][0] : 'prod';
    if (due === 'prod') return releaseStage !== 'prod';
    const when = Date.parse(due);
    return Number.isFinite(when) && when > (typeof now === 'function' ? now() : now);
  } catch { return false; }
}
/** Repo-relative POSIX form of a reported path, or null when it cannot be established (callers fail closed). */
function pathCandidates(file) {
  if (typeof file !== 'string' || /[\u0000-\u001f]/.test(file) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(file)) return null;
  let path = file.replace(/\\/g, '/');
  if (path.startsWith('/')) {
    if (!path.startsWith(REPO_ROOT.replace(/\\/g, '/'))) return null;
    path = path.slice(REPO_ROOT.length);
  }
  const parts = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!parts.length) return null; parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.length ? [parts.join('/')] : null;
}
const matchesAny = (file, pattern) => { const c = pathCandidates(file); return c === null || c.some(x => matchesPath(x, pattern)); };

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
      const protectedPath = [...BUILT_IN_REVIEW_SETTINGS.raceBlockPaths, ...raceBlockPaths].some(p => matchesAny(f.file, p));
      if (protectedPath && !f.class.startsWith('B')) {
        if (validInterleaving(f.interleaving)) f.class = 'B4';
        else if (f.class !== 'D1') f.class = 'X2';
      }
    }
    if (f.class === 'D1' || f.class === 'X2') { result.recheck.push(f); continue; }
    if (f.class === 'D2' && f.relation === 'untouched' && !d2Verified(f, options, releaseStage)) { result.blocks.push(f); continue; }
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
