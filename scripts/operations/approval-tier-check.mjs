/** D-R451 redesign: policy over upstream-validated facts, never a second evidence parser.
 * The validated scripts/settings/approval-tiers.json is the only settings source.
 * Any future overlay layer must merge monotonically: killSwitch OR, lists union, thresholds max.
 */
import { existsSync, openSync, readSync, closeSync, fstatSync, constants } from 'node:fs';
import { pathToFileURL, URL as NodeURL } from 'node:url';
import micromatch from 'micromatch';
import { readRedTeamDisposition } from '../lib/red-team-gate.mjs';

export const FLOOR = Object.freeze({
  pathGlobs: Object.freeze([
    '.github/**', '**/workflows/**', '**/*secret*', '**/*credential*', '**/*token*',
    '**/*permission*', '**/*access-control*', '**/forge-exec-run*', '**/forge-setup*',
    '**/*delete*', '**/*purge*', '**/*migration*', '**/*pricing*', '**/*licens*', '**/monetization*/**',
    'scripts/settings/approval-tiers.json', 'scripts/operations/approval-tier-check*',
    'scripts/operations/__tests__/approval-tier-check*', 'docs/agent/decision-rights*.md',
  ]),
  categories: Object.freeze(['secrets-access', 'forge-root-deploy', 'irreversible-deletion', 'pricing-licensing']),
  securityWords: Object.freeze(['security', 'secret', 'credential', 'token', 'auth', 'permission', 'access',
    'injection', 'bypass', 'escalat', 'sanitiz', 'csrf', 'xss', 'traversal', 'leak', 'password',
    'crypto', 'guard', 'gate', 'verdict', 'label', 'approval']),
  knownKinds: Object.freeze(['approval-gate', 'non-converging-verdict']),
  requireDifferentModelFamily: true,
  requireHumanRequiredFalse: true,
});
const text = x => typeof x === 'string' && x.trim().length > 0;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const requireFact = (ok, message) => { if (!ok) throw new Error(`${message}; operator review required`); };
const keysOnly = (o, keys) => requireFact(object(o) && Object.keys(o).every(k => k === '_doc' || keys.includes(k)), 'invalid/unsupported settings');
const list = xs => Array.isArray(xs) && xs.length <= 1024 && xs.every(x => text(x) && x.length <= 4096);
const includesFloor = (xs, floor) => list(xs) && floor.every(x => xs.includes(x));
const result = (tier, reasons, emergencyEligible = false) => ({ tier,
  approvableBy: tier === 'standard' ? 'orchestrator' : tier === 'elevated' ? 'elevated-judge' : 'operator', reasons, emergencyEligible });

/** Settings may add holds or increase emergency thresholds; unknown knobs are rejected. */
export function validateSettings(s) {
  keysOnly(s, ['version', 'killSwitch', 'alwaysHuman', 'emergency1', 'explicitAsk', 'requireDifferentModelFamily', 'requireHumanRequiredFalse']);
  requireFact(s.version === 1 && typeof s.killSwitch === 'boolean', 'invalid approval settings');
  for (const key of ['requireDifferentModelFamily', 'requireHumanRequiredFalse']) requireFact(s[key] === true, `immutable floor: ${key}`);
  keysOnly(s.alwaysHuman, ['pathGlobs', 'categories']);
  requireFact(includesFloor(s.alwaysHuman.pathGlobs, FLOOR.pathGlobs) && includesFloor(s.alwaysHuman.categories, FLOOR.categories), 'immutable always-human floor');
  keysOnly(s.emergency1, ['securityFindingWords', 'knownKinds', 'repeatedRefusals', 'alreadyFixedReports', 'noProgressMs']);
  const e = s.emergency1;
  requireFact(includesFloor(e.securityFindingWords, FLOOR.securityWords), 'immutable security word floor');
  requireFact(list(e.knownKinds) && e.knownKinds.every(k => FLOOR.knownKinds.includes(k)), 'invalid emergency kinds');
  for (const [key, min] of [['repeatedRefusals', 3], ['alreadyFixedReports', 2], ['noProgressMs', 7200000]])
    requireFact(Number.isSafeInteger(e[key]) && e[key] >= min, `immutable emergency threshold: ${key}`);
  keysOnly(s.explicitAsk, ['requireQuote', 'requireTimestamp', 'requireRulingId']);
  for (const key of ['requireQuote', 'requireTimestamp', 'requireRulingId']) requireFact(s.explicitAsk[key] === true, `immutable floor: explicitAsk.${key}`);
  return s;
}

/** Facts carry net paths, upstream classifications/categories and the shared disposition, not labels or prose. */
export function decideTier(f, settings) {
  try {
    const s = validateSettings(settings);
    requireFact(object(f) && text(f.head), 'head missing');
    requireFact(typeof f.humanRequired === 'boolean', 'humanRequired missing');
    requireFact(list(f.netDiffPaths) && f.netDiffPaths.length > 0 && f.netDiffPaths.every(p =>
      !p.startsWith('/') && !p.includes('\\') && !p.split('/').some(x => x === '.' || x === '..' || !x) && !/[\x00-\x1f\x7f]/.test(p)), 'invalid/oversized net paths');
    requireFact(object(f.pathKinds) && f.netDiffPaths.every(p => ['harmless', 'security-critical', 'other'].includes(f.pathKinds[p])), 'path classification missing');
    requireFact(list(f.categories), 'categories missing');
    for (const key of ['c1', 'c3', 'c4', 'acceptance']) requireFact(['PASS', 'FAIL'].includes(f[key]), `${key} unknown`);
    requireFact(f.explicitAsk === null || object(f.explicitAsk), 'explicitAsk missing');
    for (const key of ['authorModelFamily', 'judgeModelFamily']) requireFact(f[key] === null || typeof f[key] === 'string', `${key} missing`);
    const rt = f.redTeam, a = f.audit, e = f.emergency;
    requireFact(object(rt) && Object.hasOwn(rt, 'result') && Array.isArray(rt.sendBack) && Array.isArray(rt.held), 'shared red-team disposition missing');
    requireFact(object(a) && a.head === f.head && ['WEAKENED', 'NOT WEAKENED'].includes(a.verdict) && list(a.findings), 'audit missing/stale/invalid');
    requireFact(object(e) && typeof e.blocking === 'boolean' && (e.knownKind === null || text(e.knownKind)), 'emergency facts missing');
    for (const key of ['repeatedRefusals', 'alreadyFixedReports', 'noProgressMs']) requireFact(Number.isSafeInteger(e[key]) && e[key] >= 0, `emergency ${key} missing/invalid`);

    const floorPaths = f.netDiffPaths.filter(p => micromatch.isMatch(p, s.alwaysHuman.pathGlobs, { dot: true, nocase: true, nonegate: true }));
    const categories = f.categories.filter(c => s.alwaysHuman.categories.includes(c));
    const reasons = [];
    if (floorPaths.length || categories.length) reasons.push(`always-human: ${[...floorPaths, ...categories].join(', ')}`);
    // A label is never an input. No result, stale result or unresolved finding cannot mean clear.
    const redClear = rt.result?.rev === f.head && Array.isArray(rt.result.findings)
      && rt.result.findings.length === 0 && rt.sendBack.length === 0 && rt.held.length === 0;
    if (!redClear) reasons.push('red-team not clearly clear on head');
    if (f.acceptance !== 'PASS') reasons.push('review acceptance not PASS');
    if (f.c1 !== 'PASS') reasons.push('c1 failed');
    if (f.c3 !== 'PASS') reasons.push('c3 direction-setting');
    if (f.c4 !== 'PASS') reasons.push('c4 guard condition');
    if (f.humanRequired) reasons.push('humanRequired=true');
    // R455 pre-existing exception deferred until R473 structured per-finding classes.
    const weakened = a.verdict === 'WEAKENED';
    if (weakened) reasons.push('audit WEAKENED; R455 deferred until R473');
    const securityFinding = a.findings.some(line => s.emergency1.securityFindingWords.some(word => line.toLowerCase().includes(word.toLowerCase())));
    const emergencyEligible = weakened && reasons.length === 1 && !securityFinding && e.blocking
      && (s.emergency1.knownKinds.includes(e.knownKind) || e.repeatedRefusals >= s.emergency1.repeatedRefusals
        || e.alreadyFixedReports >= s.emergency1.alreadyFixedReports || e.noProgressMs >= s.emergency1.noProgressMs);
    if (floorPaths.length || categories.length || !redClear || f.acceptance !== 'PASS' || f.c1 !== 'PASS' || weakened)
      return result('human', reasons, emergencyEligible);
    if (!f.humanRequired && f.c3 === 'PASS' && f.c4 === 'PASS') return result('standard', ['all standard conditions PASS']);
    const holds = [];
    if (s.killSwitch) holds.push('elevated killSwitch enabled');
    const family = value => text(value) && !['unknown', 'unspecified', 'n/a'].includes(value.trim().toLowerCase()) ? value.trim().toLowerCase() : null;
    const author = family(f.authorModelFamily), judge = family(f.judgeModelFamily);
    if (!author || !judge || author === judge) holds.push('independent judge model family required');
    if (f.netDiffPaths.some(p => !['security-critical', 'harmless'].includes(f.pathKinds[p]))) holds.push('unclassified/non-delegable path');
    const ask = f.explicitAsk;
    if (f.c3 === 'FAIL' && (!ask || (s.explicitAsk.requireQuote && !text(ask.quote))
      || (s.explicitAsk.requireTimestamp && (!text(ask.timestamp) || !Number.isFinite(Date.parse(ask.timestamp))))
      || (s.explicitAsk.requireRulingId && !text(ask.rulingId))))
      holds.push('direction-setting requires explicit ask quote, timestamp and rulingId');
    return holds.length ? result('human', [...reasons, ...holds]) : result('elevated', [...reasons, 'elevated requirements satisfied']);
  } catch (error) { return result('unknown', [error.message]); }
}

/** PR 2 supplies the validated structured-fact adapter. Never reconstruct its evidence here. */
export async function gatherPrFacts(pr, repo) {
  const upstream = new NodeURL('./d-r379-check.mjs', import.meta.url);
  requireFact(existsSync(upstream), 'd-r379-check.mjs absent from checkout; PR 2 upstream fact gatherer required');
  const { checkPr, latestAudit, reviewed, gatherApprovalFacts } = await import(/* @vite-ignore */ upstream.href);
  requireFact([checkPr, latestAudit, reviewed, gatherApprovalFacts].every(fn => typeof fn === 'function'), 'D-R379 validated approval-fact adapter unavailable');
  // Acceptance must come from reviewed/the verdict ledger. The adapter supplies trusted complete comments,
  // not a red-team label or a separately parsed summary. Head binding is checked again by decideTier.
  const { redTeamInput, ...facts } = await gatherApprovalFacts({ pr, repo, checkPr, latestAudit, reviewed });
  requireFact(redTeamInput?.head === facts.head && redTeamInput.pr === pr && redTeamInput.repo === repo && Array.isArray(redTeamInput.comments), 'head-bound red-team inputs missing');
  return { ...facts, redTeam: readRedTeamDisposition(redTeamInput) };
}

function readBounded(file, io) {
  const fd = io.openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    requireFact(io.fstatSync(fd).isFile(), 'settings must be a regular file');
    const buffer = Buffer.alloc(65537);
    let size = 0, n;
    do { n = io.readSync(fd, buffer, size, buffer.length - size, null); size += n; } while (n && size < buffer.length);
    requireFact(size <= 65536, 'settings exceed 64KiB bound');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
  } finally { io.closeSync(fd); }
}
function readSettings(stderr, io) {
  const settings = validateSettings(JSON.parse(readBounded(new NodeURL('../settings/approval-tiers.json', import.meta.url), io)));
  stderr('approval-tiers settings source: scripts/settings/approval-tiers.json\n');
  return settings;
}

export async function main(argv, { settings, settingsIO = { openSync, fstatSync, readSync, closeSync }, gatherFacts = gatherPrFacts, stdout = s => process.stdout.write(s), stderr = s => process.stderr.write(s) } = {}) {
  let decision;
  try {
    requireFact(argv.length === 2, 'usage: --pr=N --repo=web-everything/web-everything');
    const prFlag = argv.find(a => /^--pr=[1-9][0-9]*$/.test(a));
    const pr = Number(prFlag?.slice(5));
    requireFact(Number.isSafeInteger(pr) && argv.includes('--repo=web-everything/web-everything'), 'invalid PR/repo arguments');
    const policy = validateSettings(settings ?? readSettings(stderr, settingsIO));
    decision = decideTier(await gatherFacts(pr, 'web-everything/web-everything'), policy);
  } catch (error) { decision = result('unknown', [error.message]); }
  stdout(`${JSON.stringify(decision)}\n`);
  return decision.tier === 'unknown' ? 2 : decision.tier === 'human' ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
