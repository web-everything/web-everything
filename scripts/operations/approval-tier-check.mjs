#!/usr/bin/env node
/** Read-only approval authority. Unknown evidence always escalates to the operator. */
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { runGhSync } from '../lib/gh-throttle.mjs';
import { defaultListPrComments } from '../conveyor/pr-comments-list.mjs';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { checkPr, reviewed, latestAudit, matchesGlob } from './d-r379-check.mjs';
import { createCheckDeps } from './d-r379-check-io.mjs';
import { readPlatformPreferences, resolveCascade, formatCascadeSourcesLine } from '../lib/policy-cascade.mjs';

const REPO = 'web-everything/web-everything';
const SETTINGS = new URL('../settings/approval-tiers.json', import.meta.url);
const LIMIT = 1024 * 1024;
const text = value => typeof value === 'string' && value.trim().length > 0;
const clean = value => stripVTControlCharacters(String(value)).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ');
const requireFact = (ok, reason) => { if (!ok) throw Error(reason); };

export function validateSettings(s) {
  const standard = s?.tiers?.standard, elevated = s?.tiers?.elevated, emergency = s?.emergency1;
  requireFact(s?.version === 1 && standard?.approvableBy === 'orchestrator'
    && elevated?.approvableBy === 'elevated-judge' && s?.tiers?.human?.approvableBy === 'operator'
    && standard.requireHumanRequiredFalse === true && standard.auditMustBe === 'NOT WEAKENED'
    && text(standard.rule), 'invalid tier settings');
  for (const value of [standard.allowPreExistingCardedWeakened, elevated.killSwitch,
    elevated.judge?.requireDifferentModelFamilyFromAuthor, elevated.securityCriticalRequiresRedTeamClearOnHead,
    ...['requireVerbatimQuote', 'requireTimestamp', 'requireRulingId'].map(k => elevated.explicitlyAsked?.[k])]) {
    requireFact(typeof value === 'boolean', 'invalid approval setting boolean');
  }
  for (const list of [s.alwaysHuman?.pathGlobs, s.alwaysHuman?.categories, s.securityCriticalGlobs,
    elevated.rules, emergency?.knownWontSelfResolveKinds, emergency?.neverEmergencyApprovable]) {
    requireFact(Array.isArray(list) && list.length > 0 && list.length <= 1000
      && list.every(v => text(v) && v.length <= 4096), 'invalid or oversized approval setting list');
  }
  const keywords = s.alwaysHuman.categoryKeywords;
  requireFact(keywords && typeof keywords === 'object' && !Array.isArray(keywords)
    && Object.keys(keywords).length === s.alwaysHuman.categories.length
    && Object.keys(keywords).every(k => s.alwaysHuman.categories.includes(k)), 'invalid category keyword map');
  for (const category of s.alwaysHuman.categories) {
    const words = keywords[category];
    requireFact(Array.isArray(words) && words.length > 0 && words.length <= 1000
      && words.every(v => text(v) && v.length <= 4096), 'invalid or oversized category keywords');
  }
  for (const pattern of [...s.alwaysHuman.pathGlobs, ...s.securityCriticalGlobs]) matchesGlob('probe', pattern);
  requireFact(Number.isFinite(emergency.fallbackNoProgressHours) && emergency.fallbackNoProgressHours > 0
    && Number.isFinite(emergency.fallbackNoProgressHours * 3600_000), 'invalid emergency fallback');
  for (const key of ['repeatedRefusalCount', 'alreadyFixedReportCount']) {
    requireFact(Number.isSafeInteger(emergency[key]) && emergency[key] > 0, 'invalid emergency count');
  }
  requireFact(emergency.neverEmergencyApprovable.every(v =>
    ['security-finding-in-diff', 'secrets-access', 'irreversible-action'].includes(v)), 'unknown emergency exclusion');
  return s;
}

// Accept repository-relative and Git a/ or b/ paths, optionally prefixed by ./.
// Retain both interpretations of a/ and b/: those can also be real directories.
function findingPaths(token) {
  const relative = token.replace(/^(?:\.\/)+/, '');
  if (!relative || relative.endsWith('.') || relative.split('/').some(part =>
    !part || part === '.' || part === '..' || !/^[\w@.-]+$/.test(part))) return null;
  const unprefixed = relative.replace(/^[ab]\//, '');
  return [relative, unprefixed];
}

function findingCards(line) {
  return [...line.matchAll(/#(\d+)\b|\b(?:card|backlog)[\s/#:-]+((?=[a-z\d-]*\d)[a-z\d][\w-]*)\b|\bbacklog\/(\d+)[\w-]*\.md\b/gi)]
    .map(m => m[1] ?? m[2] ?? m[3]);
}

/** Conservative R455 classifier: every named file must be outside the net diff. */
export function classifyFindings(findings, netDiffPaths) {
  // This prose tokenizer cannot preserve whitespace inside filenames. If the
  // diff contains one, split fragments cannot prove a finding is outside it;
  // refuse the R455 exception and require operator review instead.
  if (!Array.isArray(findings) || !findings.length || findings.some(line => !text(line))
    || netDiffPaths.some(path => /\s/.test(path))) {
    return { status: 'UNKNOWN', securityInDiff: false };
  }
  let status = 'PASS', securityInDiff = false;
  for (const line of findings) {
    // Capture whole path-like tokens, including unsupported forms. Never salvage
    // a valid-looking suffix from traversal, absolute or otherwise ambiguous paths.
    const tokens = (line.match(/[^\s`'"(),;:]+/g) ?? []).filter(token =>
      /[/\\]/.test(token) || /^[\w@-]+\.[\w.-]+$/.test(token));
    const parsed = tokens.map(findingPaths);
    const paths = parsed.filter(Boolean).flat();
    const inDiff = netDiffPaths.some(path => line.includes(path))
      || paths.some(path => netDiffPaths.includes(path));
    securityInDiff ||= inDiff && /security|secret|credential/i.test(line);
    if (!paths.length || parsed.includes(null) || /[\x00-\x1f\x7f-\x9f]/.test(line)) status = 'UNKNOWN';
    else if (status !== 'UNKNOWN' && (inDiff || !/\bpre-existing\b/i.test(line)
      || !findingCards(line).length || /\b(?:relies|depends|now\s+exposes|newly)\b/i.test(line))) status = 'FAIL';
  }
  return { status, securityInDiff };
}

/** Extra evidence has no inferred provenance: absent operator/emergency records are null. */
export function createApprovalDeps(options = {}) {
  const { cwd = process.cwd(), env = process.env, exec = (bin, args, opts) => bin === 'gh' ? runGhSync(args, opts) : execFileSync(bin, args, opts),
    fs: io = fs } = options;
  const deps = createCheckDeps(options);
  const read = path => {
    const fd = io.openSync(path, io.constants.O_RDONLY | io.constants.O_NONBLOCK);
    try {
      const stat = io.fstatSync(fd);
      requireFact(stat.isFile() && stat.size <= LIMIT, 'settings bound exceeded; operator review required');
      const buffer = Buffer.alloc(LIMIT + 1);
      let size = 0, count;
      do { count = io.readSync(fd, buffer, size, buffer.length - size, null); size += count; }
      while (count && size < buffer.length);
      requireFact(size <= LIMIT, 'settings grew beyond bound; operator review required');
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
    } finally { io.closeSync(fd); }
  };
  return { ...deps,
    readApprovalSettings() {
      const tool = validateSettings(JSON.parse(read(SETTINGS)));
      const platform = readPlatformPreferences({ env, readFile: read, warn: s => deps.stderr(`${clean(s)}\n`) });
      requireFact(!platform.errors.length, 'unreadable approval platform settings');
      const resolved = resolveCascade({ standard: {}, platform: platform.prefs['approval-tiers'], tool });
      deps.stderr(`${clean(formatCascadeSourcesLine('approval-tiers', resolved))}\n`);
      return validateSettings(resolved.value);
    },
    cardExists(id) {
      requireFact(typeof id === 'string' && /^[a-z\d][\w-]*$/i.test(id), 'invalid backlog card id');
      return io.readdirSync(join(cwd, 'backlog'), { withFileTypes: true })
        .some(entry => entry.isFile() && entry.name.startsWith(`${id}-`) && entry.name.endsWith('.md'));
    },
    readRedTeam(pr, head) {
      requireFact(Number.isSafeInteger(pr) && pr > 0 && /^[a-f\d]{40}$/i.test(head), 'invalid red-team scope');
      let bytes = 0;
      const comments = defaultListPrComments({ number: pr, repo: REPO, maxPages: 10, gh: args => {
        const output = exec('gh', args, { cwd, env, encoding: 'utf8', timeout: 60_000,
          maxBuffer: LIMIT, stdio: ['ignore', 'pipe', 'pipe'] });
        requireFact(typeof output === 'string' || Buffer.isBuffer(output), 'invalid comment output; operator review required');
        bytes += Buffer.byteLength(output);
        requireFact(bytes <= LIMIT, 'comment byte bound exceeded; operator review required');
        return JSON.parse(String(output));
      } });
      let newest = null;
      for (const comment of comments) {
        requireFact(typeof comment.body === 'string', 'incomplete comment evidence; operator review required');
        if (!isTrustedMarkerAuthor(comment)) continue;
        const marker = /^<!-- we:red-team-advisory pr=(\d+) rev=([a-f\d]{40}) -->/i.exec(comment.body.trimStart());
        if (!marker || Number(marker[1]) !== pr || marker[2] !== head) continue;
        // Read the producer's recorded verdict, never infer clear from an empty parse.
        const verdict = /^Advisory only:.* · recorded verdict `([^`]+)`\.$/m.exec(comment.body)?.[1];
        const at = Date.parse(comment.createdAt);
        requireFact(Number.isFinite(at), 'red-team timestamp unknown; operator review required');
        if (!newest || at >= newest.at) newest = { at, head: marker[2], result: verdict === 'accept' ? 'clear' : (verdict ?? 'unknown') };
      }
      return newest ? { head: newest.head, result: newest.result } : null;
    },
    async readShape(files) {
      requireFact(files.every(path => !path.includes(',') && path === path.trim()), 'lossy shape paths; operator review required');
      const output = await exec(process.execPath, ['scripts/review-core-cli.mjs', 'shape', `--files=${files.join(',')}`, '--json'],
        { cwd, env, encoding: 'utf8', timeout: 60_000, maxBuffer: LIMIT, stdio: ['ignore', 'pipe', 'pipe'] });
      requireFact((typeof output === 'string' || Buffer.isBuffer(output)) && Buffer.byteLength(output) <= LIMIT,
        'invalid or oversized shape output; operator review required');
      return JSON.parse(String(output));
    },
    classifyFindings, readExplicitAsk: async () => null, readEmergency: async () => null,
  };
}

export async function checkApprovalTier(pr, deps, repo = REPO) {
  let head = null;
  const result = (tier, approvableBy, reasons, emergencyEligible = false) => ({ pr, head, tier, approvableBy, reasons, emergencyEligible });
  try {
    requireFact(repo === REPO, 'unsupported repo');
    const settings = validateSettings(await deps.readApprovalSettings());
    // Cache promises, including failures: checkPr and reviewed must see identical evidence.
    const snapshot = { ...deps };
    for (const key of ['readPr', 'fetchNetDiff', 'readLabels', 'readReviewLedger', 'readAudits', 'readLabelEvents']) {
      let promise;
      snapshot[key] = (...args) => promise ??= Promise.resolve().then(() => deps[key](...args));
    }
    const facts = await checkPr(pr, snapshot);
    head = facts.head;
    const metadata = await snapshot.readPr(pr);
    const categoryText = `${metadata.title}\n${metadata.body}\n${facts.netDiffPaths.join('\n')}`.toLowerCase();
    const categories = settings.alwaysHuman.categories.filter(category =>
      settings.alwaysHuman.categoryKeywords[category].some(word => categoryText.includes(word.toLowerCase())));
    if (categories.length) return result('human', settings.tiers.human.approvableBy,
      categories.map(category => `always-human category: ${category}`));
    const redTeam = await deps.readRedTeam?.(pr, head);
    requireFact(redTeam != null, 'head-bound red-team evidence absent');
    const redTeamClear = redTeam.head === head && redTeam.result === 'clear';
    const hits = globs => facts.netDiffPaths.filter(path => globs.some(glob => matchesGlob(path, glob)));
    const alwaysHuman = hits(settings.alwaysHuman.pathGlobs), securityCritical = hits(settings.securityCriticalGlobs);
    const conditions = [1, 3, 4].map(id => facts.conditions.find(c => c.id === id));
    // An explicit never-delegate path already settles authority, even when D-R379
    // has no harmless-path classification for it. Other unknowns still fail closed.
    requireFact(alwaysHuman.length || conditions.every(c => ['PASS', 'FAIL'].includes(c?.status)),
      `unknown conditions: ${conditions.filter(c => c?.status !== 'PASS' && c?.status !== 'FAIL').map(c => c?.evidence?.join('; ')).join('; ')}`);
    const { base } = await snapshot.fetchNetDiff(pr, head);
    const acceptance = await reviewed(pr, head, base, snapshot, { skipAudit: true });
    requireFact(['PASS', 'FAIL'].includes(acceptance.status), `acceptance unknown: ${acceptance.evidence.join('; ')}`);
    const audit = latestAudit(await snapshot.readAudits(), head, base);
    requireFact(audit && audit.base === base && audit.base !== head, 'no audit bound to head and net-diff base');
    const shape = await deps.readShape(facts.netDiffPaths);
    requireFact(typeof shape?.humanRequired === 'boolean', 'shape humanRequired unknown');
    const classification = audit.verdict === 'WEAKENED'
      ? await (deps.classifyFindings ?? classifyFindings)(audit.findings, facts.netDiffPaths)
      : { status: 'PASS', securityInDiff: false };
    requireFact(['PASS', 'FAIL'].includes(classification?.status)
      && typeof classification.securityInDiff === 'boolean', 'audit findings unclassifiable');
    let cardsVerified = classification.status === 'PASS';
    if (audit.verdict === 'WEAKENED' && cardsVerified) {
      for (const line of audit.findings) {
        let exists = false;
        for (const id of findingCards(line)) {
          requireFact(typeof deps.cardExists === 'function', 'card existence reader unavailable');
          if (await deps.cardExists(id) === true) exists = true;
        }
        cardsVerified &&= exists;
      }
    }
    const auditPassing = audit.verdict === settings.tiers.standard.auditMustBe
      || (settings.tiers.standard.allowPreExistingCardedWeakened && classification.status === 'PASS' && cardsVerified);
    const reasons = [];
    if (!redTeamClear) reasons.push('red-team not clear on current head');
    if (alwaysHuman.length) reasons.push(`always-human paths: ${alwaysHuman.join(', ')}`);
    if (acceptance.status !== 'PASS') reasons.push(`acceptance/red-team failed: ${acceptance.evidence.join('; ')}`);
    if (!auditPassing) reasons.push('audit failing: WEAKENED findings are not all pre-existing, outside the net diff and carded');
    for (const c of conditions) if (c.status === 'FAIL') reasons.push(`condition ${c.id} failed: ${c.evidence.join('; ')}`);
    if (shape.humanRequired) reasons.push('shape humanRequired=true (R454)');
    let emergencyEligible = false;
    if (!alwaysHuman.length && redTeamClear && acceptance.status === 'PASS' && !classification.securityInDiff
      && ((audit.verdict === 'WEAKENED' && audit.findings.length > 0)
        || (!auditPassing && !shape.humanRequired && conditions.every(c => c.status === 'PASS')))) {
      const emergency = await deps.readEmergency(pr);
      if (emergency !== null) {
        requireFact(emergency && typeof emergency.blocking === 'boolean', 'invalid emergency evidence');
        for (const key of ['repeatedRefusals', 'alreadyFixedReports', 'noProgressMs']) {
          requireFact(emergency[key] === undefined || (Number.isFinite(emergency[key]) && emergency[key] >= 0
            && (key === 'noProgressMs' || Number.isSafeInteger(emergency[key]))), 'invalid emergency measurement');
        }
        requireFact(emergency.knownKind === undefined || emergency.knownKind === null || text(emergency.knownKind), 'invalid emergency kind');
        const e = settings.emergency1;
        emergencyEligible = emergency.blocking && (e.knownWontSelfResolveKinds.includes(emergency.knownKind)
          || emergency.repeatedRefusals >= e.repeatedRefusalCount || emergency.alreadyFixedReports >= e.alreadyFixedReportCount
          || emergency.noProgressMs >= e.fallbackNoProgressHours * 3600_000);
      }
    }
    if (alwaysHuman.length || !redTeamClear || acceptance.status !== 'PASS' || !auditPassing || conditions[0].status !== 'PASS') {
      return result('human', settings.tiers.human.approvableBy, reasons, emergencyEligible);
    }
    if (!shape.humanRequired && conditions.every(c => c.status === 'PASS')) {
      return result('standard', settings.tiers.standard.approvableBy, ['conditions 1,3,4, acceptance/red-team, audit and shape clear'], emergencyEligible);
    }
    const elevated = settings.tiers.elevated;
    const blockers = [];
    if (elevated.killSwitch) blockers.push('elevated kill-switch enabled');
    if (elevated.judge.requireDifferentModelFamilyFromAuthor) {
      const author = await deps.readAuthorModelFamily?.(pr), judge = await deps.readJudgeModelFamily?.(pr);
      if (!text(author) || !text(judge)) blockers.push('author/judge model family unknown');
      else if (author.trim().toLowerCase() === judge.trim().toLowerCase()) blockers.push('judge and author use the same model family');
    }
    if (conditions[1].status === 'FAIL') {
      const ask = await deps.readExplicitAsk(pr), rule = elevated.explicitlyAsked;
      if (!ask || (rule.requireVerbatimQuote && !text(ask.quote))
        || (rule.requireTimestamp && (!text(ask.timestamp) || !Number.isFinite(Date.parse(ask.timestamp))))
        || (rule.requireRulingId && !text(ask.rulingId))) blockers.push('direction-setting requires explicit ask with quote, timestamp and rulingId');
    }
    if (securityCritical.length && elevated.securityCriticalRequiresRedTeamClearOnHead) reasons.push('security-critical files: head-bound red-team acceptance clear');
    return blockers.length ? result('human', settings.tiers.human.approvableBy, [...reasons, ...blockers], emergencyEligible)
      : result('elevated', elevated.approvableBy, [...reasons, 'elevated requirements satisfied'], emergencyEligible);
  } catch (error) {
    return result('unknown', 'operator', [`${clean(error?.message ?? error)}; operator review of the full diff or repair evidence and retry`]);
  }
}

export async function main(argv, deps) {
  let pr, repo, json = false, valid = true;
  for (const arg of argv) {
    if (/^--pr=[1-9]\d*$/.test(arg) && pr === undefined) pr = Number(arg.slice(5));
    else if (arg.startsWith('--repo=') && repo === undefined) repo = arg.slice(7);
    else if (arg === '--json' && !json) json = true;
    else valid = false;
  }
  let checked;
  if (!valid || !Number.isSafeInteger(pr) || repo !== REPO) {
    checked = { pr: pr ?? null, head: null, tier: 'unknown', approvableBy: 'operator',
      reasons: ['usage: --pr=N --repo=web-everything/web-everything [--json]; operator review required'], emergencyEligible: false };
  } else {
    try { checked = await checkApprovalTier(pr, deps ?? createApprovalDeps(), repo); }
    catch (error) {
      checked = { pr, head: null, tier: 'unknown', approvableBy: 'operator',
        reasons: [`${clean(error?.message ?? error)}; operator review required`], emergencyEligible: false };
    }
  }
  (deps?.stdout ?? (s => process.stdout.write(s)))(json ? `${JSON.stringify(checked)}\n`
    : `PR #${checked.pr} @ ${checked.head}: ${checked.tier}; approvable by ${checked.approvableBy}\n${checked.reasons.map(clean).join('\n')}\nemergencyEligible: ${checked.emergencyEligible}\n`);
  return checked.tier === 'unknown' ? 2 : checked.tier === 'human' ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
