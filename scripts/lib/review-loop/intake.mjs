/** Stateless, head-bound review intake. Labels never supply evidence. */
import defaults from '../../settings/review-intake.json' with { type: 'json' };
import { pathToFileURL } from 'node:url';
import { matchesAny } from '../standards-sections.mjs';
import { OPEN_PR_MAX_NON_TEST_LINES, parseNumstat, measureEntries } from '../pr-size-accounting.mjs';
import { createGitReader } from '../pr-size-admission.mjs';
import { isTrustedMarkerAuthor } from '../marker-authorship.mjs';
import { cascadePolicy } from '../policy-cascade.mjs';
const standard = { maxLines: OPEN_PR_MAX_NON_TEST_LINES, ...defaults.intake };
const sha = /^[a-f0-9]{40}(?![\s\S])/;
const unknown = () => ({ verdict: 'unknown', reason: 'unverifiable', lines: null, round: null });
export function readIntakeSettings({ env = process.env, tool = standard, ...options } = {}) {
  const envValues = Object.fromEntries(Object.entries(standard).map(([key, value]) => {
    const raw = env[`WE_REVIEW_INTAKE_${key.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`];
    return [key, raw === undefined ? undefined : typeof value === 'number' ? Number(raw)
      : typeof value === 'boolean' ? JSON.parse(raw) : Array.isArray(value) ? JSON.parse(raw) : raw];
  }));
  const value = cascadePolicy('intake', tool, { standard: { ...standard, maxLines: OPEN_PR_MAX_NON_TEST_LINES }, envValues, env, ...options }).value;
  if (!['off', 'shadow', 'on'].includes(value.enforce) || !Number.isSafeInteger(value.maxLines) || value.maxLines < 0
    || !Number.isSafeInteger(value.roundsBeforeSplit) || value.roundsBeforeSplit < 1
    || value.countRule !== 'non-test-non-data' || value.overCapAction !== 'split-after-rounds'
    || !['exemptPaths', 'generatedPaths', 'atomicExempt'].every(k => Array.isArray(value[k]) && value[k].every(v => typeof v === 'string'))
    || typeof value.urgentExempt !== 'boolean' || typeof value.trackOverrides !== 'boolean') throw Error('invalid intake settings; operator must repair policy');
  return value;
}
export function check(subject, params = {}) {
  try {
    const p = { ...standard, ...params }, { entries, head, baseSha, round, markers = [] } = subject;
    if (!Array.isArray(entries) || !sha.test(head) || !sha.test(baseSha) || !Number.isSafeInteger(round) || round < 0
      || !Number.isSafeInteger(p.maxLines) || p.maxLines < 0 || !Number.isSafeInteger(p.roundsBeforeSplit) || p.roundsBeforeSplit < 1) throw Error('missing evidence');
    const exempt = path => matchesAny(path, p.exemptPaths);
    const generated = path => p.atomicExempt.includes('generated') && matchesAny(path, p.generatedPaths);
    const counted = entries.filter(e => {
      if (!Array.isArray(e.paths) || !e.paths.length || e.paths.some(path => typeof path !== 'string' || !path || path.split('/').some(s => !s || s === '.' || s === '..'))
        || !Number.isSafeInteger(e.changed) || e.changed < 0) throw Error('invalid numstat');
      return !(e.paths.length === 2 && e.changed === 0 && p.atomicExempt.includes('rename-only')) && !e.paths.every(path => exempt(path) || generated(path));
    });
    const { lines } = measureEntries(counted);
    const result = { verdict: 'pass', reason: 'under-cap', lines, round, head, baseSha };
    let urgent, override;
    for (const marker of markers) {
      if (!isTrustedMarkerAuthor(marker)) continue;
      const m = /^<!-- intake-(urgent|override) pr=(\d+) (?:head=([a-f0-9]{40}) reason=(.+)|ruling=(R\d+)) -->$/.exec(marker.body?.split('\n')[0]);
      if (!m || Number(m[2]) !== Number(subject.pr ?? subject.number)) continue;
      if (m[1] === 'urgent') urgent = m[3] === head && m[4].trim() ? m[4] : null;
      else override = m[5];
    }
    if (override) return { ...result, reason: 'override', ...(p.trackOverrides ? { overrideUsed: override } : {}) };
    if (urgent && p.urgentExempt) return { ...result, reason: 'exempt', exemptReason: 'urgent' };
    if (!counted.length) return { ...result, reason: 'exempt', exemptReason: 'paths-or-atomic' };
    if (lines <= p.maxLines) return result;
    return round >= p.roundsBeforeSplit ? { ...result, verdict: 'fail', reason: 'split-required' }
      : { ...result, reason: 'first-review', observation: 'over-cap' };
  } catch { return unknown(); }
}
export function readIntake(pr, { git = createGitReader(process.cwd()), diffStat, params = {} } = {}) {
  try {
    const head = pr.headRefOid ?? pr.head;
    if (!sha.test(head)) throw Error('unpinned head');
    let evidence;
    if (diffStat) evidence = diffStat({ sha: head, base: pr.baseRefName ?? 'main' });
    else {
      const base = pr.baseRefSha ?? `refs/remotes/origin/${pr.baseRefName ?? 'main'}`;
      const baseSha = git(['merge-base', head, base]).trim();
      if (!sha.test(baseSha)) throw Error('unpinned merge-base');
      evidence = { sha: head, baseSha, text: git(['-c', 'core.attributesFile=', 'diff', '--no-ext-diff', '--no-textconv', '--numstat', '-z', '--find-renames', baseSha, head, '--']) };
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
  const prs = number ? [gh(['pr', 'view', number, '--json', fields])] : gh(['pr', 'list', '--state', 'open', '--limit', '1000', '--json', fields]);
  if (!Array.isArray(prs) || prs.length >= 1000) throw Error('incomplete intake listing; operator must inspect open PRs');
  const params = readIntakeSettings();
  for (const pr of prs) {
    try { pr.comments = readCompletePrComments(pr.number, { gh, repo: 'web-everything/web-everything' }); pr.round = sharedRoundAttempts(pr); }
    catch { pr.round = null; }
    const v = readIntake(pr, { git, params });
    if (number || v.verdict !== 'pass') log(`${number ? '' : `#${pr.number} `}${v.verdict} ${v.reason} lines=${v.lines} round=${v.round}`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch(() => { console.error('unknown unverifiable; operator must inspect intake evidence'); process.exitCode = 1; });
