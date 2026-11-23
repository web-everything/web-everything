/** Stateless, head-bound review intake. Labels never supply evidence. */
import defaults from '../../settings/review-intake.json' with { type: 'json' };
import { pathToFileURL } from 'node:url';
import { matchesAny } from '../standards-sections.mjs';
import { OPEN_PR_MAX_NON_TEST_LINES, parseNumstat, measureEntries } from '../pr-size-accounting.mjs';
import { createGitReader } from '../pr-size-admission.mjs';
import { isTrustedMarkerAuthor } from '../marker-authorship.mjs';
import { cascadePolicy } from '../policy-cascade.mjs';
import { loadPrSizeSettingsFile } from '../pr-size-settings.mjs';
const standard = { maxLines: OPEN_PR_MAX_NON_TEST_LINES, ...defaults.intake };
const sha = /^[a-f0-9]{40}(?![\s\S])/;
const unknown = () => ({ verdict: 'unknown', reason: 'unverifiable', lines: null, round: null });
const SIZE_KEYS = ['dataExtensions', 'dataDirs', 'dataPaths'];
/** The size runner's own resolved data classification. Anything else is unmeasurable, never a silent default. */
function sizeSettingsOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !SIZE_KEYS.every(k => Array.isArray(value[k]) && value[k].every(v => typeof v === 'string'))) throw Error('invalid size settings');
  return Object.freeze(Object.fromEntries(SIZE_KEYS.map(k => [k, Object.freeze([...value[k]])])));
}
const strings = v => Array.isArray(v) && v.every(s => typeof s === 'string');
const VALID = Object.freeze({
  enforce: v => ['off', 'shadow', 'on'].includes(v),
  maxLines: v => Number.isSafeInteger(v) && v >= 0,
  roundsBeforeSplit: v => Number.isSafeInteger(v) && v >= 1,
  countRule: v => v === 'non-test-non-data',
  overCapAction: v => v === 'split-after-rounds',
  exemptPaths: strings, generatedPaths: strings, atomicExempt: strings,
  urgentExempt: v => typeof v === 'boolean', trackOverrides: v => typeof v === 'boolean',
});
/**
 * Invalid settings never throw: the pass that reads them must keep reconciling every other PR. A readable
 * enforce mode is kept (off stays off, shadow stays shadow); an unreadable one fails closed to `on`. Either
 * way every PR's intake is unknown (human review of the full diff) until the operator repairs the policy.
 */
export function invalidIntakeSettings(enforce, invalid) {
  const mode = VALID.enforce(enforce) ? enforce : 'on';
  try { console.error(`intake settings invalid (${invalid}); intake unknown for every PR; enforce=${mode}; operator must repair intake policy`); } catch { /* best-effort */ }
  return Object.freeze({ enforce: mode, invalid: String(invalid), sizeSettings: null });
}
/** Resolve once, with the caller's environment, and carry the result into every later stage. */
export function readIntakeSettings({ env = process.env, tool = standard, loadSize = e => loadPrSizeSettingsFile(undefined, { env: e }), ...options } = {}) {
  const unparsable = [];
  const envValues = Object.fromEntries(Object.entries(standard).map(([key, value]) => {
    const raw = env[`WE_REVIEW_INTAKE_${key.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`];
    if (raw === undefined) return [key, undefined];
    try { return [key, typeof value === 'number' ? Number(raw) : typeof value === 'boolean' || Array.isArray(value) ? JSON.parse(raw) : raw]; }
    catch { unparsable.push(key); return [key, undefined]; }
  }));
  let value;
  try { value = cascadePolicy('intake', tool, { standard: { ...standard, maxLines: OPEN_PR_MAX_NON_TEST_LINES }, envValues, env, ...options }).value; }
  catch { return invalidIntakeSettings(undefined, 'cascade'); }
  const invalid = [...new Set([...unparsable, ...Object.keys(VALID).filter(k => !VALID[k](value?.[k]))])];
  if (invalid.length) return invalidIntakeSettings(unparsable.includes('enforce') ? undefined : value?.enforce, invalid.join(','));
  // A bad prSize layer makes each PR's intake unknown (human review), as it makes the size runner unknown.
  let sizeSettings = null;
  try { sizeSettings = sizeSettingsOf(loadSize(env)); } catch {
    try { console.error('prSize settings unreadable; intake unknown for every PR; operator must repair prSize policy'); } catch { /* best-effort */ }
  }
  return { ...value, sizeSettings };
}
export function check(subject, params = {}) {
  try {
    const p = { ...standard, ...params }, { entries, head, baseSha, round, markers = [] } = subject;
    if (p.invalid || !Array.isArray(entries) || !sha.test(head) || !sha.test(baseSha) || !Number.isSafeInteger(round) || round < 0
      || !Number.isSafeInteger(p.maxLines) || p.maxLines < 0 || !Number.isSafeInteger(p.roundsBeforeSplit) || p.roundsBeforeSplit < 1) throw Error('missing evidence');
    const exempt = path => matchesAny(path, p.exemptPaths);
    const generated = path => p.atomicExempt.includes('generated') && matchesAny(path, p.generatedPaths);
    const counted = entries.filter(e => {
      if (!Array.isArray(e.paths) || !e.paths.length || e.paths.some(path => typeof path !== 'string' || !path || path.split('/').some(s => !s || s === '.' || s === '..'))
        || !Number.isSafeInteger(e.changed) || e.changed < 0) throw Error('invalid numstat');
      return !(e.paths.length === 2 && e.changed === 0 && p.atomicExempt.includes('rename-only')) && !e.paths.every(path => exempt(path) || generated(path));
    });
    // Same classification as the size runner: the caller's resolved settings, else this process's resolution.
    const sizeSettings = sizeSettingsOf(Object.hasOwn(params, 'sizeSettings') ? params.sizeSettings : loadPrSizeSettingsFile());
    const { lines } = measureEntries(counted, sizeSettings);
    const result = { verdict: 'pass', reason: 'under-cap', lines, round, head, baseSha, sizeSettings };
    let urgent, override;
    for (const marker of markers) {
      if (!isTrustedMarkerAuthor(marker)) continue;
      const m = /^<!-- intake-(urgent|override) pr=(\d+) (?:head=([a-f0-9]{40}) reason=(.+)|ruling=(R\d+)) -->$/.exec(marker.body?.split('\n')[0]);
      if (!m || Number(m[2]) !== Number(subject.pr ?? subject.number)) continue;
      if (m[1] === 'urgent') urgent = m[3] === head && m[4].trim() ? m[4] : null;
      else override = m[5];
    }
    if (override) return { ...result, reason: 'override', overrideUsed: override };
    if (urgent && p.urgentExempt) return { ...result, reason: 'exempt', exemptReason: 'urgent' };
    if (!counted.length) return { ...result, reason: 'exempt', exemptReason: 'paths-or-atomic' };
    if (lines <= p.maxLines) return result;
    return round >= p.roundsBeforeSplit ? { ...result, verdict: 'fail', reason: 'split-required' }
      : { ...result, reason: 'first-review', observation: 'over-cap' };
  } catch { return unknown(); }
}
export function readIntake(pr, { git = createGitReader(process.cwd()), diffStat, params = {} } = {}) {
  try {
    if (params.invalid) throw Error('invalid intake settings');
    const head = pr.headRefOid ?? pr.head;
    if (!sha.test(head)) throw Error('unpinned head');
    let evidence;
    if (diffStat) evidence = diffStat({ sha: head, base: pr.baseRefName ?? 'main' });
    else {
      const base = pr.baseRefSha ?? `refs/remotes/origin/${pr.baseRefName ?? 'main'}`;
      const baseSha = git(['merge-base', head, base]).trim();
      if (!sha.test(baseSha)) throw Error('unpinned merge-base');
      evidence = { sha: head, baseSha, text: git(['-c', 'core.attributesFile=', '-c', 'diff.relative=false', 'diff', '--no-relative', '--no-ext-diff', '--no-textconv', '--numstat', '-z', '--find-renames', baseSha, head, '--']) };
    }
    if (evidence.sha !== head) throw Error('stale size request');
    return check({ ...pr, pr: pr.number ?? pr.pr, head, baseSha: evidence.baseSha, entries: parseNumstat(evidence.text), markers: pr.comments ?? pr.markers }, params);
  } catch { return unknown(); }
}
export async function main(argv, { gh, git, log = console.log } = {}) {
  const { runGhSync } = await import('../gh-throttle.mjs');
  const { readCompletePrComments } = await import('../../conveyor/pr-comments-complete.mjs');
  const { sharedRoundAttempts } = await import('../../conveyor/reconcile-core.mjs');
  let calls = 0;
  gh ??= args => { if (++calls > 128) throw Error('intake call budget exhausted; operator must inspect remaining PRs'); return JSON.parse(runGhSync(args, { encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 })); };
  const number = argv.find(a => /^--pr=\d+$/.test(a))?.slice(5);
  const fields = 'number,headRefOid,baseRefName';
  const { ghRepoSlug } = await import('../constellation-repos.mjs');
  const repo = ghRepoSlug(gh(['repo', 'view', '--json', 'nameWithOwner']).nameWithOwner);
  const prs = number ? [gh(['pr', 'view', number, '--repo', repo, '--json', fields])]
    : gh(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '1000', '--json', fields]);
  if (!Array.isArray(prs) || prs.length >= 1000) throw Error('incomplete intake listing; operator must inspect open PRs');
  const params = readIntakeSettings();
  for (const pr of prs) {
    try { pr.comments = readCompletePrComments(pr.number, { gh, repo }); pr.round = sharedRoundAttempts(pr); }
    catch { pr.round = null; }
    const v = readIntake(pr, { git, params });
    if (!argv.includes('--shadow') && ['fail', 'unknown'].includes(v.verdict)) process.exitCode = 1;
    if (number || v.verdict !== 'pass') log(`${number ? '' : `#${pr.number} `}${v.verdict} ${v.reason} lines=${v.lines} round=${v.round}`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch(() => { console.error('unknown unverifiable; operator must inspect intake evidence'); process.exitCode = 1; });
