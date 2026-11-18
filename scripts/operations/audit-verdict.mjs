/**
 * Pure audit projection of platform-decisions#review-stringency-classified-outcomes (AU1 PR-A).
 * INERT: no runtime file imports this module yet (a grep test pins that). D2 pre-existing debt counts only with a
 * relationProof bound to {base, head, fingerprint}; the model's `relation` label is never read for D2.
 */
const RELEASE_STAGES = Object.freeze(['prerelease', 'prod']);
import { GUARD_FLOOR, resolveAuditSettings } from '../lib/audit-settings.mjs';
import { canonicalPaths, anchorsOf, assertProtectedPatterns } from '../lib/audit-path.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL as NodeURL } from 'node:url';

export const FINDING_CLASSES = Object.freeze(['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'E1', 'E2', 'D1', 'D2', 'D3', 'X1', 'X2']);
const scopeKeys = ['file', 'line', 'invariant', 'trigger', 'consequence', 'relation'];
const text = value => typeof value === 'string' && value.trim().length > 0;
export const findingIdentity = f => JSON.stringify([f?.file, f?.invariant]);
/**
 * Full re-check binding: a re-check may keep or downgrade the SAME fingerprint, never another finding.
 * Every evidence column is bound (location, trigger, consequence, card, ruling); only the D1->D3
 * downgrade may restate the trigger (codex-audit.mjs). Interleaving stays unbound: adding one only escalates.
 */
export const findingFingerprint = f => JSON.stringify([f?.id, f?.file, f?.line, f?.invariant, f?.class, f?.relation,
  f?.trigger ?? null, f?.consequence, f?.card ?? null, f?.ruling ?? null, f?.hunkHash ?? null]);
/** Identity a relationProof binds to. Deliberately excludes the model's `relation` label. */
export const proofFingerprint = f => JSON.stringify([f?.id, f?.file, f?.line, f?.invariant, f?.class, f?.trigger ?? null, f?.consequence,
  f?.card ?? null, f?.ruling ?? null, f?.hunkHash ?? null]);
const validProof = (f, proofs, base, head) => text(base) && text(head) && Array.isArray(proofs)
  && proofs.some(p => p && p.ok === true && p.base === base && p.head === head && p.fingerprint === proofFingerprint(f));
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

/**
 * Literal globs: * matches within one segment, a run of two or more * spans directories, every other character is
 * literal; a trailing / is a directory prefix. Matched by a bitset state walk (bit i = "pattern token i is next"),
 * never a backtracking regex (PR #6381: nested `**` made a regex take exponential time). Cost is a few bitset
 * operations per path character; path and pattern lengths are bounded upstream.
 */
function matchesPath(file, pattern) {
  if (pattern.endsWith('/')) {
    // A literal directory stays a plain prefix. One holding a wildcard (`custom/**/`, `custom/*/`) was a literal
    // prefix too, so it protected nothing (PR #6381 judge): it now matches like the same glob without the trailing
    // slashes, or anything under what that glob matches. Matching more only ever protects more.
    if (!pattern.includes('*')) return file.startsWith(pattern);
    const dir = pattern.replace(/\/+$/, '');
    return globMatch(file, dir) || globMatch(file, `${dir}/**`);
  }
  return globMatch(file, pattern);
}
function globMatch(file, pattern) {
  const lit = new Map(); let star = 0n; let globstar = 0n; let n = 0n;
  for (let i = 0; i < pattern.length; n++) {
    const bit = 1n << n;
    if (pattern[i] !== '*') { lit.set(pattern[i], (lit.get(pattern[i]) ?? 0n) | bit); i++; continue; }
    let j = i; while (pattern[j] === '*') j++;
    if (j - i >= 2) globstar |= bit; else star |= bit;
    i = j;
  }
  const wild = star | globstar;
  // A wildcard may match nothing, so reaching it also reaches the next token. Runs of * are one token, so a
  // wildcard is never followed by another and one shift closes the set.
  const close = s => s | ((s & wild) << 1n);
  let s = close(1n);
  for (let c = 0; c < file.length; c++) {
    const ch = file[c];
    s = close((s & (ch === '/' ? globstar : wild)) | ((s & (lit.get(ch) ?? 0n)) << 1n));
    if (s === 0n) return false;
  }
  return ((s >> n) & 1n) === 1n;
}

const REPO_ROOT = fileURLToPath(new NodeURL('../../', import.meta.url));
// End-of-input anchor, as HASH_64 has (PR #6381 judge): `$` would also match before a line break under the `m` flag.
const CARD_PATH = /^backlog\/[A-Za-z0-9._-]+\.md(?![\s\S])/;
/**
 * Default card reader: the card must exist on origin/main AS IT IS NOW. A local origin/main can be stale (a card since
 * deleted or a pay-by since moved would still read), so the ref is fetched first (PR #6381 judge). Any failure,
 * including a failed fetch, is unavailable (null). `run` is a test seam.
 */
export function readCardFromMain(path, { run = spawnSync } = {}) {
  if (typeof path !== 'string' || !CARD_PATH.test(path)) return null;
  // Non-interactive: a credential prompt must fail fast, not wait out the timeout.
  const git = args => run('git', args, { cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000, maxBuffer: 1 << 20,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  try {
    const fetched = git(['fetch', '--quiet', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
    if (!fetched || fetched.error || fetched.status !== 0) return null;
    // The full ref name: a local branch named `origin/main` would shadow the short name and serve a stale card.
    const r = git(['show', `refs/remotes/origin/main:${path}`]);
    return !r || r.error || r.status !== 0 || typeof r.stdout !== 'string' ? null : r.stdout;
  } catch { return null; }
}
/**
 * D2 debt ships only when its card exists on main and its pay-by date has not passed. The pay-by date is
 * read only from that card, never from the model finding. A card due `prod` blocks at prod. Unreadable => false.
 * Each requirement is enforced on its own: a missing card clears only when both requireOnMain and requirePayBy are
 * waived, and a card without a pay-by line clears only when requirePayBy is waived.
 */
function d2Verified(f, releaseStage, { readCard = readCardFromMain, now = Date.now, requireOnMain = true, requirePayBy = true } = {}) {
  try {
    if (typeof f.card !== 'string' || !CARD_PATH.test(f.card)) return false;
    const body = readCard(f.card);
    // A missing card has no pay-by date either, so it clears only when BOTH requirements are waived: waiving the
    // card alone never waives a required pay-by (PR #6381 red team).
    if (typeof body !== 'string' || !body.trim()) return requireOnMain === false && requirePayBy === false;
    // Any pay-by-looking line (indent, case, spacing, trailing text) must parse strictly, or it fails closed.
    const lines = body.split(/\r\n|[\n\r\p{Zl}\p{Zp}]/u).filter(l => /^\s*must[\s_-]*pay[\s_-]*before\s*:/i.test(l.normalize('NFKC')));
    if (lines.length > 1) return false;
    const due = lines.length ? /^mustPayBefore: *(\S+) *$/.exec(lines[0])?.[1] : undefined;
    if (lines.length && due === undefined) return false;
    if (due === undefined) return requirePayBy === false;
    if (due === 'prod') return releaseStage !== 'prod';
    const when = payByTime(due);
    // The clock is a code seam only: a plain value (a number from parsed data, `now: 0`) would move "now" into the
    // past and pass an overdue pay-by, so a plain finite number may only move "now" LATER (a stricter clock), and any
    // other non-function reads the real clock (PR #6381 self-review).
    const clock = typeof now === 'function' ? now()
      : (typeof now === 'number' && Number.isFinite(now) ? Math.max(Date.now(), now) : Date.now());
    return Number.isFinite(when) && when > clock;
  } catch { return false; }
}
/**
 * A pay-by date is exactly `YYYY-MM-DD` and a real calendar day (UTC midnight). `Date.parse` is not used: it rolls an
 * impossible day into the next month (`2099-02-31` → March 3) and accepts other formats (PR #6381). Anything else is NaN.
 */
function payByTime(due) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due);
  if (!m) return NaN;
  const [y, mo, d] = m.slice(1).map(Number);
  const t = Date.UTC(y, mo - 1, d); const day = new Date(t);
  return day.getUTCFullYear() === y && day.getUTCMonth() === mo - 1 && day.getUTCDate() === d ? t : NaN;
}
/** Most globs one CALLER list may carry (the trusted lists are bounded by audit-settings: the floor plus 256 per layer). */
const MAX_GLOBS = GUARD_FLOOR.length + 512;
/**
 * Legacy cleanup for caller-supplied patterns; configured settings are validated before this fold.
 * Compatibility form (NFKC); invisible, control, format, line and paragraph separator
 * characters and the blank Braille pattern dropped; the dash, slash and dot lookalikes NFKC keeps (U+2011, U+2212,
 * U+2215, U+3002, ...) read as `-`, `/` and `.`. Written as escapes: a raw invisible in source is refused by check:standards.
 */
const foldPathText = s => s.normalize('NFKC')
  .replace(/[\p{Default_Ignorable_Code_Point}\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u{2800}]/gu, '')
  .replace(/[\p{Pd}\u{2212}\u{2043}]/gu, '-')
  .replace(/[\u{2215}\u{2044}\u{2216}\u{29f5}\u{29f8}\u{29f9}]/gu, '/')
  .replace(/[\u{b7}\u{589}\u{6d4}\u{2027}\u{2219}\u{22c5}\u{2e31}\u{2e33}\u{3002}\u{30fb}]/gu, '.');
// Case-insensitive: the checkout may sit on a case-insensitive file system, where `Scripts/Guard-Bash.mjs` IS the guard.
// Folding both sides only ever protects more paths. The candidates are computed once per path, not once per glob.
// A pattern is cleaned up the way a path candidate is (PR #6381 self-review), else `./custom/**`, `/custom/**`,
// `custom/./**`, `custom<U+200B>/**` or a fullwidth letter matched no candidate and protected nothing: compatibility form
// (NFKC), surrounding whitespace trimmed, invisible, control and format characters dropped, `\` read as `/`, empty and
// `.` segments dropped, `..` resolved. A pattern that cleans up to nothing (`./`, `/`) names the repo root, and one that
// climbs above it (`../x`) cannot be placed: both protect every path. A trailing `/` (a directory) is kept.
const cleanPattern = p => {
  // Trimmed AFTER the invisible characters go, so a space beside one (`custom/** <U+200B>`) is trimmed too.
  const s = foldPathText(p).trim().replace(/\\/g, '/');
  const segs = [];
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!segs.length) return '**'; segs.pop(); continue; }
    segs.push(seg);
  }
  if (!segs.length) return '**';
  return `${segs.join('/')}${s.endsWith('/') ? '/' : ''}`.toLowerCase();
};
export const matchesSome = (file, patterns) => {
  const clean = patterns.map(cleanPattern);
  const c = canonicalPaths(file, anchorsOf(clean));
  return c === null || clean.some(p => c.some(x => matchesPath(x.toLowerCase(), p)));
};

export function computeVerdict(findings, options = {}) {
  // Settings come from the trusted running checkout (strictest on any failure), never from the candidate or the
  // caller. There is deliberately no settings argument: tests mock the resolver module instead.
  const trusted = resolveAuditSettings().value;
  assertProtectedPatterns(trusted.raceBlockPaths);
  assertProtectedPatterns(trusted.guardFloorPaths);
  // A caller may only TIGHTEN the trusted settings: a stricter stage, more protected paths. It can never relax them.
  const { rulings = [], relationProofs = [], base, head } = options;
  const stageOption = options.releaseStage ?? trusted.releaseStage;
  const releaseStage = trusted.releaseStage === 'prod' && RELEASE_STAGES.includes(stageOption) ? 'prod' : stageOption;
  // `allow` is never trusted: it resolves to block. Proven D2 debt ships only when the trusted mode is `prove` and the
  // caller does not ask for something stricter.
  const proveD2 = trusted.preExistingMode === 'prove' && (options.preExistingMode ?? 'prove') === 'prove';
  // Card requirements: the trusted value is a floor (PR #6381 judge). The effective value is trusted || caller, so a
  // caller can require a card or a pay-by the trusted settings waive, never waive one they require. Only an omitted
  // caller value defers; any other value that is not exactly `false` (a typo, a string) counts as a request to tighten.
  const callerRequires = v => v !== undefined && v !== false;
  const requireOnMain = trusted.requireOnMain !== false || callerRequires(options.requireOnMain);
  const requirePayBy = trusted.requirePayBy !== false || callerRequires(options.requirePayBy);
  const result = { verdict: 'NOT WEAKENED', blocks: [], ships: [], cards: [], recheck: [] };
  // Caller glob lists are bounded (count and length) so matching cost is bounded; a bad list is invalid input.
  // The trusted lists were bounded by the resolver.
  const validGlobs = list => Array.isArray(list) && list.length <= MAX_GLOBS && list.every(p => text(p) && p.length <= 512);
  const raceOption = options.raceBlockPaths ?? []; const guardOption = options.guardFloorPaths ?? [];
  const raceBlockPaths = validGlobs(raceOption) ? [...new Set([...trusted.raceBlockPaths, ...raceOption])] : null;
  const guardFloorPaths = validGlobs(guardOption) ? [...new Set([...trusted.guardFloorPaths, ...guardOption])] : null;
  if (!Array.isArray(findings) || !RELEASE_STAGES.includes(releaseStage)
    || raceBlockPaths === null || guardFloorPaths === null || !Array.isArray(rulings)) {
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
      const protectedPath = matchesSome(f.file, [...GUARD_FLOOR, ...raceBlockPaths]);
      if (protectedPath && !f.class.startsWith('B')) {
        if (validInterleaving(f.interleaving)) f.class = 'B4';
        else if (f.class !== 'D1') f.class = 'X2';
      }
    }
    if (f.class === 'D1' || f.class === 'X2') { result.recheck.push(f); continue; }
    // D2: never reads f.relation. It ships only in prove mode, with an ok relationProof bound to base+head+fingerprint,
    // and a card on main whose pay-by is current.
    if (f.class === 'D2' && !(proveD2 && validProof(f, relationProofs, base, head) && d2Verified(f, releaseStage, { ...options, requireOnMain, requirePayBy }))) { result.blocks.push(f); continue; }
    // E findings in guard paths always block; a path that cannot be established blocks too.
    if (f.class.startsWith('E') && matchesSome(f.file, [...GUARD_FLOOR, ...guardFloorPaths])) { result.blocks.push(f); continue; }
    if (f.class.startsWith('B') || (releaseStage === 'prod' && f.class.startsWith('E'))) { result.blocks.push(f); continue; }
    result.ships.push(f);
    result.cards.push({ ...f, ...(f.class === 'E1' ? { outcome: 'expedite', deadlineHours: 72 }
      : f.class === 'D2' ? { outcome: 'debt', mustPayBefore: 'prod', mustExistOnMain: true }
        : f.class === 'E2' ? { outcome: 'debt' }
          : f.class === 'X1' ? { outcome: 'accepted-risk' } : { outcome: 'advisory' }) });
  }
  if (result.blocks.length || result.recheck.length) result.verdict = 'WEAKENED';
  return result;
}
