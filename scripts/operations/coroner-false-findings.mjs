#!/usr/bin/env node
/** Read-only false-finding census. Guesses are evidence hints, never adjudications.
 * Reads complete PR threads, bounded to 500 updated PRs; unmatched agy findings stay apart.
 * --since=last reads WE_CORONER_STATE without advancing it. Run before coroner-extract.
 */
import fs from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readCompletePrComments } from '../conveyor/pr-comments-complete.mjs';
import { readGhJson } from '../lib/proc-read.mjs';
import { sameRepo, readOperatorRulings, readReferralRecords } from '../lib/jury-core.mjs';
import { normalizeComment } from './coroner-rounds.mjs';
import { readShadowRows, resolveShadowAgreementPath } from '../lib/review-shadow-agreement.mjs';
import { FALSE_FINDING_CAUSES } from '../lib/false-finding-causes.mjs';
import { classifyCardOnly } from '../ci-card-only.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
export { FALSE_FINDING_CAUSES };
const inWindow = (at, w) => Date.parse(at) >= Date.parse(w.since) && Date.parse(at) < Date.parse(w.until);
const keyParts = (key) => { try { const p = JSON.parse(key); return Array.isArray(p) ? p : []; } catch { return []; } };

/** Rule precedence: explicit cause, policy, stale, card scope, diff restriction, config, test. */
export function guessFalseFindingCause(f) {
  if (FALSE_FINDING_CAUSES.includes(f.cause)) return f.cause;
  const text = `${f.reason ?? ''} ${f.claim ?? ''}`;
  if (f.policyOverNotReal || /auto.policy.*(?:re.block|not.real)|policy.carri/i.test(text)) return 'auto-policy-over-not-real';
  if (f.stale || /stale|re.rais|already (?:fixed|present)|fixed (?:at|on|round)|send.back history/i.test(text)) return 'stale-head-reraise';
  if (f.source === 'red-team' && f.prType === 'card-only' && /(?:code|runtime|implementation|outside|not in|absent|only.*diff)/i.test(text)) return 'card-only-probe';
  if (/not (?:in|part of|visible in).*diff|outside.*diff|diff.only|only.*diff|not.*(?:provided|supplied).*diff/i.test(text)) return 'diff-only-recheck';
  if (/^scripts\/settings\//.test(f.file ?? '') && /prose|description|false|default|resolved|behavio[u]?r/i.test(text)) return 'config-prose';
  if (/no (?:explicit )?(?:planned )?test|planned.test|test.only nit|test nit|test.plan/i.test(text)) return 'test-nit';
  return 'other';
}

/** Pure extraction; old comments remain available as context, but only window events count. */
export function falseFindingsForPr({ repo, pr, prType = 'unknown', comments, window }) {
  const normalized = comments.map(c => ({ ...c, author: { login: c.author?.login ?? c.user?.login ?? '' } }));
  const { rulings } = readOperatorRulings(normalized);
  const records = normalized.flatMap(c => readReferralRecords([c], { repo, pr }).records.map(r => ({ ...r, at: c.createdAt ?? c.created_at })));
  const out = [];
  for (const r of rulings) {
    if (!sameRepo(r.repo, repo) || r.pr !== pr || r.result !== 'not-real' || !inWindow(r.at, window)) continue;
    const [lens, file, line, claim] = keyParts(r.key);
    const same = key => { const p = keyParts(key); return p[0] === lens && p[1] === file && p[3] === claim; };
    const reviewerNotReal = records.flatMap(rec => (rec.rulings ?? []).filter(o => o.result === 'not-real' && same(o.key)).map(() => rec.at));
    const policyOverNotReal = rulings.some(o => o.actor === 'auto-policy' && o.result === 'block' && same(o.key)
      && Date.parse(o.at) < Date.parse(window.until)
      && [r.at, ...reviewerNotReal].some(t => Date.parse(t) < Date.parse(o.at)));
    out.push({ source: 'operator', repo, pr, prType, at: r.at, lens: r.lens ?? lens ?? 'unknown', seat: r.seat ?? lens ?? 'unknown', file, line, claim, reason: r.reason, cause: r.cause, stale: rulings.some(o => o.result === 'not-real' && o.head !== r.head && Date.parse(o.at) < Date.parse(r.at) && same(o.key)), policyOverNotReal });
  }
  for (const c of normalized) {
    const n = normalizeComment(c);
    if (!n.trusted || !inWindow(n.at, window)) continue;
    if (/^### Post-accept red team —/m.test(n.body)) {
      const seat = n.body.match(/· red team ([^\n·]+)/)?.[1]?.trim() ?? 'unknown';
      for (const m of n.body.matchAll(/^\d+\. \[not confirmed\]([^\n]*)((?:\n[ \t]+[^\n]*)*)/gm)) {
        const file = m[1].match(/`([^`]+?)(?::(\d+))?`/);
        out.push({ source: 'red-team', repo, pr, prType, at: n.at, lens: m[1].match(/\(([^,)]+)/)?.[1] ?? 'unknown', seat,
          file: file?.[1] ?? null, line: file?.[2] ? Number(file[2]) : null, claim: m[1], reason: m[2].trim(), ref: c.url ?? c.id });
      }
    } else if (/conveyor fix — stood down/.test(n.body) && /does not reproduce/i.test(n.body)) {
      out.push({ source: 'fixer', repo, pr, prType, at: n.at, lens: 'unknown', seat: 'fixer', claim: 'does not reproduce', reason: n.body.slice(0, 2000), ref: c.url ?? c.id });
    }
  }
  return out.map(f => ({ ...f, cause: guessFalseFindingCause(f), causeBasis: f.cause ? 'recorded' : 'rule', claim: String(f.claim ?? '').slice(0, 500), reason: String(f.reason ?? '').slice(0, 1000) }));
}

const group = (items, field) => {
  const out = Object.create(null);
  for (const f of items) { const k = f[field] ?? 'unknown'; out[k] ??= { count: 0, examples: [] }; out[k].count++; if (out[k].examples.length < 3) out[k].examples.push(f); }
  return out;
};
export function summarizeFalseFindings(findings, unconfirmed = [], reads = {}) {
  const summarize = xs => ({ count: xs.length, byCause: group(xs, 'cause'), bySource: group(xs, 'source'), byLens: group(xs, 'lens'), bySeat: group(xs, 'seat'), byPrType: group(xs, 'prType') });
  const summary = summarize(findings);
  for (const cause of FALSE_FINDING_CAUSES) summary.byCause[cause] ??= { count: 0, examples: [] };
  return { ...summary, basis: 'Source events, not unique defects; fixer stand-downs may overlap rulings. Agy unmatched findings are unconfirmed, not proven false.',
    byKind: Object.fromEntries(['code', 'card-only', 'unknown'].map(k => [k, summarize(findings.filter(f => f.prType === k))])),
    unconfirmed: summarize(unconfirmed), reads };
}

/** All GitHub reads use shared readers/throttle. Failed or capped reads are visible. */
export function collectFalseFindings(window, { repo = CONSTELLATION_REPOS.we.slug, gh = readGhJson,
  readComments = readCompletePrComments, shadowRows = readShadowRows(), maxPages = 5 } = {}) {
  const reads = { prs: 0, failed: 0, truncated: false }, prs = [], findings = [], kinds = new Map();
  for (let page = 1; page <= maxPages; page++) {
    let rows;
    try { rows = gh(['api', `repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${page}`]); if (!Array.isArray(rows)) throw Error(); }
    catch { reads.failed++; break; }
    prs.push(...rows.filter(p => Date.parse(p.updated_at) >= Date.parse(window.since)));
    if (rows.length < 100 || Date.parse(rows.at(-1).updated_at) < Date.parse(window.since)) break;
    if (page === maxPages) reads.truncated = true;
  }
  for (const p of prs) {
    reads.prs++;
    let prType = 'unknown';
    try {
      const pages = gh(['api', '--paginate', '--slurp', `repos/${repo}/pulls/${p.number}/files?per_page=100`]);
      if (!Array.isArray(pages)) throw Error();
      const files = pages.flat();
      prType = classifyCardOnly({ event: 'pull_request', files: files.map(f => f.filename) }).light ? 'card-only' : 'code';
    } catch { reads.failed++; }
    kinds.set(p.number, prType);
    try { findings.push(...falseFindingsForPr({ repo, pr: p.number, prType, comments: readComments(p.number, { repo }), window })); }
    catch { reads.failed++; }
  }
  const unconfirmed = shadowRows.filter(r => r.repo === repo && r.status === 'ok' && !Object.hasOwn(r, 'fellBackTo') && inWindow(r.at, window))
    .flatMap(r => (r.agyFindings ?? []).filter(f => f.matched === false).map(f => ({ source: 'agy-shadow', repo, pr: r.pr, at: r.at, lens: r.lens, seat: `agy/${r.model ?? 'unknown'}`, prType: kinds.get(r.pr) ?? 'unknown', file: f.path, line: f.line, cause: 'other' })));
  return summarizeFalseFindings(findings, unconfirmed, reads);
}

export function runFalseFindings(argv, { env = process.env, home = homedir(), now = new Date().toISOString(), io = fs, collect = collectFalseFindings } = {}) {
  // --until bounds the window like coroner-extract's, so the nightly job reads both halves over the same window.
  const { values } = parseArgs({ args: argv, options: { since: { type: 'string' }, until: { type: 'string' }, json: { type: 'boolean' } } });
  let since = values.since;
  if (since === 'last') since = JSON.parse(io.readFileSync(env.WE_CORONER_STATE || join(home, 'workspace/.operations/state/coroner-last.json'), 'utf8')).lastEnd;
  const validISO = (v) => /^\d{4}-\d{2}-\d{2}T/.test(v ?? '') && Number.isFinite(Date.parse(v));
  if (!validISO(since) || Date.parse(since) > Date.parse(now)) throw Error('pass an ISO --since or last with previous coroner state');
  const until = values.until ?? now;
  if (!validISO(until) || Date.parse(until) > Date.parse(now) || Date.parse(since) > Date.parse(until)) throw Error('pass an ISO --until with since <= until <= now');
  const window = { since: new Date(since).toISOString(), until: values.until === undefined ? now : new Date(until).toISOString() };
  const report = { window, ...collect(window, { shadowRows: readShadowRows({ path: resolveShadowAgreementPath(env), read: io.readFileSync.bind(io) }) }) };
  return { report, output: values.json ? JSON.stringify(report) : JSON.stringify(report, null, 2) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(runFalseFindings(process.argv.slice(2)).output); }
  catch (e) { console.error(`coroner-false-findings: ${e.message}`); process.exitCode = 1; }
}
