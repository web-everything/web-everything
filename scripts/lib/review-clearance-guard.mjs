/** Preserve a trusted clearance when a repair dispatch has not moved the head. */
import { isCandidacyHold, readMergeGateVerdict } from './merge-gate-hold-class.mjs';
import { REVIEW_CLEARANCE_SETTINGS, resolveReviewClearanceSetting, loadReviewClearanceSetting } from './review-clearance-settings.mjs';

export { REVIEW_CLEARANCE_SETTINGS, resolveReviewClearanceSetting, loadReviewClearanceSetting };
import { latestAcceptRecord, isKnownMachineBody, laterReviewHold } from './accept-carry-forward.mjs';
import { isTrustedMarkerAuthor, isAutomationAuthored } from './marker-authorship.mjs';
import { parseLatestHumanClearedSha } from './review-escalation.mjs';
import { collapseRollupToLatestPerName } from './rollup-collapse.mjs';
import { FAILING_CONCLUSIONS } from '../operations/pr-status.mjs';
import { runGhSync } from './gh-throttle.mjs';
import { isGhDeferred } from './gh-deferred.mjs';

let sweepOffset = 0;
export const REARM_MARKER = '🔧 conveyor fix — re-armed for re-review';
const RESTORE_MARKER = '🔔 conveyor — review clearance restored (no push since the clearance)';
const holds = ['review:human', 'review:pending', 'review:changes', 'review:held-mechanical'];
const enabled = setting => (typeof setting === 'string' ? setting : setting?.value) === 'on';
const names = labels => Array.isArray(labels) ? labels.map(l => typeof l === 'string' ? l : l?.name) : [];
const at = c => c?.createdAt ?? c?.created_at;
const starts = (c, marker) => typeof c?.body === 'string' && c.body.split(/\r?\n/)[0].startsWith(marker);
const sameHead = (record, prHead, refHead) => /^[0-9a-f]{40}$/.test(record?.sha ?? '') && record.sha === prHead && record.sha === refHead;
const jobIdOf = row => Number(/\/job\/(\d+)/.exec(row?.detailsUrl ?? row?.details_url ?? '')?.[1] ?? row?.id);
const failing = row => FAILING_CONCLUSIONS.includes(String(row?.conclusion ?? row?.state).toLowerCase());

export function classifyGateFailure({ name, verdict } = {}) {
  if (name === 'review-gate') return { ciBreak: false, kind: 'review-gate', why: 'review-gate reads review labels' };
  if (name !== 'merge-gate') return { ciBreak: true, kind: 'real', why: 'failing CI check' };
  if (verdict?.error || !Array.isArray(verdict?.results) || !verdict.results.length
    || verdict.results.some(r => !r || !['pass', 'hold', 'fail-closed', 'queue', 'enqueue', 'skipped-by-policy'].includes(r.status) || !r.id)) {
    return { ciBreak: true, kind: 'unreadable', why: 'merge-gate verdict unreadable' };
  }
  const blocking = verdict.results.filter(r => r.status === 'hold' || r.status === 'fail-closed');
  if (blocking.length && blocking.every(isCandidacyHold)) return { ciBreak: false, kind: 'review-hold', why: 'merge-gate has only review/candidacy holds' };
  return { ciBreak: true, kind: 'real', why: 'merge-gate has real or absent blocking evidence' };
}

export function failingCiChecks({ rows, verdictFor = () => ({ error: 'unreadable' }), setting } = {}) {
  const checks = [], excluded = [];
  for (const row of collapseRollupToLatestPerName(rows).filter(failing)) {
    let classification = { ciBreak: true, why: 'review exclusions off' };
    if (enabled(setting)) {
      let verdict;
      try { verdict = row.name === 'merge-gate' ? verdictFor(row) : undefined; }
      catch (e) { verdict = { error: e.message }; }
      classification = classifyGateFailure({ name: row.name ?? row.context, verdict });
    }
    if (classification.ciBreak) checks.push(row);
    else excluded.push({ row, ...classification });
  }
  return { failing: checks, excluded };
}

/** A human-only HOLD that the live human clearance now covers is re-run at most once per this interval (backoff). */
export const HUMAN_ONLY_RERUN_BACKOFF_MS = 30 * 60_000;

export function decideStaleGateRerun({ setting, labels, record, row, verdict, rows, humanClearedSha = null, head = null, now = Date.now() } = {}) {
  const no = why => ({ rerun: false, why });
  if (!enabled(setting)) return no('stale gate rerun off');
  const ls = names(labels);
  if (!ls.includes('review:accepted') || holds.some(l => ls.includes(l))) return no('no live clearance');
  if (Array.isArray(rows) && rows.some(r => r.name === 'merge-gate' && r.status
    && String(r.status).toLowerCase() !== 'completed')) return no('merge-gate run already pending');
  const latest = collapseRollupToLatestPerName(rows).find(r => r.name === 'merge-gate');
  if (!latest || latest !== row || String(latest.status).toLowerCase() !== 'completed' || !failing(latest)) return no('no latest completed failed merge-gate');
  if (classifyGateFailure({ name: row.name, verdict }).kind !== 'review-hold') return no('gate is not a review-only hold');
  const completed = Date.parse(verdict?.completed_at ?? row.completedAt ?? row.completed_at);
  if (!Number.isFinite(completed)) return no('failed job completion time unreadable');
  const jobId = jobIdOf(row);
  if (!Number.isSafeInteger(jobId) || jobId <= 0) return no('job id unreadable');
  if (Date.parse(record?.at) > completed) return { rerun: true, jobId, why: 'review-only merge-gate predates live clearance' };
  // #5193: a clearance can be current while the job still HOLDs human-only (the CI reader lagged the clearance, e.g. a
  // same-sha plain accept shadowed it). When the live human clearance names this head, re-run with a backoff so the
  // gate turns green once CI reads the clearance, without a re-run every tick.
  const humanOnly = verdict.results.some(r => r.status === 'hold' && r.id === 'review-acceptance' && String(r.reason ?? '').startsWith('human-only:'));
  if (humanOnly && /^[0-9a-f]{40}$/.test(humanClearedSha ?? '') && humanClearedSha === head && now - completed >= HUMAN_ONLY_RERUN_BACKOFF_MS) {
    return { rerun: true, jobId, why: `human-only hold, but the live human clearance covers ${head.slice(0, 9)}; re-run after a ${HUMAN_ONLY_RERUN_BACKOFF_MS / 60_000}-minute backoff` };
  }
  return no('clearance is not newer than the failed job');
}

export function decideRearmGuard({ setting, labels, record, prHead, refHead } = {}) {
  const refuse = enabled(setting) && names(labels).includes('review:accepted') && sameHead(record, prHead, refHead);
  return { refuse, why: refuse ? `same-head clearance at ${record.sha}; no push since acceptance` : 'same-head clearance unproven or guard off' };
}

export function decideClearanceRestore({ setting, labels, comments, reviews, events, prHead, refHead } = {}) {
  const no = why => ({ restore: false, why });
  if (!enabled(setting)) return no('clearance restoration off');
  const ls = names(labels);
  if (!ls.includes('review:pending') || ['review:accepted', ...holds.filter(l => l !== 'review:pending')].some(l => ls.includes(l))) return no('labels do not permit restoration');
  const record = latestAcceptRecord(comments);
  if (!sameHead(record, prHead, refHead) || !Number.isFinite(Date.parse(record?.at))) return no('same head clearance unproven');
  if (!Array.isArray(reviews) || laterReviewHold(reviews, record.at)) return no('formal reviews unreadable or hold clearance');
  if (!Array.isArray(events)) return no('issue events unreadable');
  const later = comments.slice(record.index + 1);
  const rearms = later.filter(c => starts(c, REARM_MARKER) && isTrustedMarkerAuthor(c) && Date.parse(at(c)) > Date.parse(record.at));
  const rearmComment = rearms.at(-1);
  if (!rearmComment) return no('no later trusted re-arm');
  if (later.some(c => starts(c, RESTORE_MARKER) && isTrustedMarkerAuthor(c)
    && c.body.includes(prHead) && Date.parse(at(c)) > Date.parse(at(rearmComment)))) return no('restoration already recorded');
  if (later.some(c => !rearms.includes(c) && !isKnownMachineBody(c?.body)
    && !(isTrustedMarkerAuthor(c) && c?.body?.startsWith('<!-- approval-prevention-filed:')))) return no('intervening comment holds clearance');
  const removals = events.filter(e => e.event === 'unlabeled' && e.label?.name === 'review:accepted');
  if (removals.some(e => !Number.isFinite(Date.parse(at(e))))) return no('unlabel event time unreadable');
  const removal = removals.sort((a, b) => Date.parse(at(a)) - Date.parse(at(b))).at(-1);
  const login = removal?.actor?.login;
  if (!login || !isAutomationAuthored({ author: { login } }) || !(Date.parse(at(removal)) > Date.parse(record.at))
    || !rearms.some(c => Math.abs(Date.parse(at(c)) - Date.parse(at(removal))) <= 180_000)) return no('accepted removal not tied to trusted re-arm');
  // Only the original automated pending swap is exempt. Actor equality alone cannot prove that a later
  // label event belongs to that swap: a subsequent hold from the same identity is still a revocation.
  const originalPending = events.find(e => e.event === 'labeled' && e.label?.name === 'review:pending'
    && Date.parse(at(e)) === Date.parse(at(removal))
    && String(e.actor?.login ?? '').toLowerCase() === login.toLowerCase());
  if (events.some(e => e.event === 'labeled' && holds.includes(e.label?.name)
    && (!Number.isFinite(Date.parse(at(e))) || Date.parse(at(e)) > Date.parse(record.at))
    && e !== originalPending)) return no('intervening label hold');
  return { restore: true, record: { ...record, url: comments[record.index]?.url }, rearmComment, why: 'trusted no-push re-arm removed the original clearance' };
}

export function buildRestoreComment({ head, record, rearm, setting }) {
  return `${RESTORE_MARKER}\n\nHead: ${head}. Original clearance carried from ${record.url} at ${record.at}.\nRe-arm: ${rearm.url} at ${at(rearm)} removed \`review:accepted\` with no push (the head is still the cleared head).\nNo new verdict or acceptance marker is written; the original clearance record above stands.\nreviewClearance.restoreNoPushRearm=${typeof setting === 'string' ? setting : setting.value} (source: ${setting.source ?? 'standard'}).`;
}

/** Cheap pre-check (comments only): is there a trusted re-arm after a same-sha accept record, not yet restored? */
export function mayNeedRestore({ comments, prHead } = {}) {
  const record = latestAcceptRecord(comments);
  if (!record || record.sha !== prHead) return false;
  const later = comments.slice(record.index + 1);
  const last = later.map((c, i) => [c, i]).filter(([c]) => starts(c, REARM_MARKER) && isTrustedMarkerAuthor(c)).at(-1);
  return !!last && !later.slice(last[1] + 1).some(c => starts(c, RESTORE_MARKER) && isTrustedMarkerAuthor(c));
}

export function readPrClearanceFacts({ repo, pr, runGh = runGhSync, full = true }) {
  const read = args => {
    try { return JSON.parse(runGh(args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], throttle: { op: 'review-clearance-read', repo } })); }
    catch { return null; }
  };
  // Every list read is complete (`--paginate --slurp`, flattened); a failed read is null, never a partial list.
  const list = path => { const pages = read(['api', '--paginate', '--slurp', `${path}?per_page=100`]); return Array.isArray(pages) ? pages.flat() : null; };
  const view = read(['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid,headRefName,labels,statusCheckRollup']);
  const rest = view ? list(`repos/${repo}/issues/${pr}/comments`) : null;
  const comments = rest && rest.map(c => ({ body: c.body, createdAt: c.created_at, author: { login: c.user?.login ?? '' }, url: c.html_url }));
  const facts = { prHead: view?.headRefOid ?? null, refHead: null, labels: view?.labels ?? null, comments,
    rows: view?.statusCheckRollup ?? null, reviews: null, events: null };
  // `full: 'if-restore'` (the sweep) pays for reviews / events / the ref read only when a restore is plausible.
  if (!view || (full === 'if-restore' && !(comments && mayNeedRestore(facts)))) return facts;
  const ref = view.headRefName ? read(['api', `repos/${repo}/git/ref/heads/${view.headRefName}`]) : null;
  return { ...facts, refHead: ref?.object?.sha ?? null,
    reviews: list(`repos/${repo}/pulls/${pr}/reviews`), events: list(`repos/${repo}/issues/${pr}/events`) };
}

export function createReviewClearanceGuard({ repo, runGh = runGhSync, readVerdict = readMergeGateVerdict,
  loadSetting = loadReviewClearanceSetting, log = line => console.error(line) } = {}) {
  const setting = key => loadSetting({ key, log });
  const mutate = args => {
    const result = runGh(args, { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'], throttle: { op: 'review-clearance-write', repo } });
    if (isGhDeferred(result)) throw new Error('review clearance write deferred');
    return result;
  };
  const reruns = new Set();
  const apply = (pr, facts) => {
    const restoreSetting = setting('restoreNoPushRearm');
    const restoration = decideClearanceRestore({ ...facts, setting: restoreSetting });
    let restored = false;
    if (restoration.restore) {
      mutate(['pr', 'edit', String(pr), '--repo', repo, '--add-label', 'review:accepted', '--remove-label', 'review:pending']);
      mutate(['pr', 'comment', String(pr), '--repo', repo, '--body', buildRestoreComment({ head: facts.prHead, record: restoration.record, rearm: restoration.rearmComment, setting: restoreSetting })]);
      facts.labels = [...names(facts.labels).filter(l => l !== 'review:pending'), 'review:accepted'];
      restored = true;
    }
    const cache = new Map();
    const verdictFor = row => {
      const jobId = jobIdOf(row);
      if (!cache.has(jobId)) {
        const verdict = readVerdict({ repo, jobId, prNumber: pr, runGh });
        cache.set(jobId, verdict?.num === pr && verdict?.head_sha === facts.prHead ? verdict : { error: 'verdict not bound to PR head' });
      }
      return cache.get(jobId);
    };
    const row = collapseRollupToLatestPerName(facts.rows).find(r => r.name === 'merge-gate');
    const rerun = decideStaleGateRerun({ setting: setting('rerunStaleGateOnClearance'), labels: facts.labels,
      record: latestAcceptRecord(facts.comments), row, rows: facts.rows, verdict: row && failing(row) ? verdictFor(row) : null,
      humanClearedSha: parseLatestHumanClearedSha(facts.comments ?? []), head: facts.prHead });
    if (rerun.rerun && !reruns.has(rerun.jobId)) {
      mutate(['api', '-X', 'POST', `repos/${repo}/actions/jobs/${rerun.jobId}/rerun`]);
      reruns.add(rerun.jobId);
    }
    return { restored, rerun: rerun.rerun, verdictFor };
  };
  return {
    beforeCiHeal(entry) {
      try {
        const pr = entry.prNumber ?? entry.pr;
        const facts = readPrClearanceFacts({ repo, pr, runGh });
        const { restored, rerun, verdictFor } = apply(pr, facts);
        if (restored || rerun) log(`review-clearance: PR #${pr} restored=${restored} merge-gate-rerun=${rerun}`);
        const required = setting('ciHealRequiresFailingChecks');
        if (entry.reason !== 'codeql' && enabled(required) && Array.isArray(facts.rows)) {
          const notCi = setting('reviewHoldIsNotCiFailure');
          const result = failingCiChecks({ rows: facts.rows, verdictFor, setting: notCi });
          if (!result.failing.length) {
            const excluded = result.excluded.map(x => `${x.row.name} (${x.kind})`).join(', ') || 'none';
            return { launch: false, restored, rerun, why: `no failing CI checks after review exclusions [excluded: ${excluded}]`
              + ` — reviewClearance.ciHealRequiresFailingChecks=${required.value} (source: ${required.source}), reviewHoldIsNotCiFailure=${notCi.value} (source: ${notCi.source})` };
          }
        }
        return { launch: true, why: 'CI heal allowed', restored, rerun };
      } catch (e) { return { launch: true, why: `guard error: ${e.message}` }; }
    },
    sweep(rows, { max = 10 } = {}) {
      const results = [];
      try {
        const eligible = [...new Map((rows ?? []).map(row => [row.prNumber ?? row.pr ?? row.number, names(row.labels)]))]
          .filter(([pr, ls]) => pr && (ls.includes('review:pending') || ls.includes('review:accepted')) && !ls.includes('review:human') && !ls.includes('review:changes'));
        // Rotate so a long review:pending list is covered over successive ticks, `max` view reads per tick.
        const start = eligible.length ? sweepOffset % eligible.length : 0;
        const batch = [...eligible.slice(start), ...eligible.slice(0, start)].slice(0, max);
        sweepOffset += batch.length;
        for (const [pr] of batch) {
          try {
            const facts = readPrClearanceFacts({ repo, pr, runGh, full: 'if-restore' });
            if (facts.prHead && Array.isArray(facts.comments)) results.push({ pr, ...apply(pr, facts) });
          } catch (e) { log(`review-clearance: PR #${pr} sweep error: ${e.message}`); }
        }
      } catch { /* Best effort sweep. */ }
      for (const r of results) if (r.restored || r.rerun) log(`review-clearance: PR #${r.pr} restored=${r.restored} merge-gate-rerun=${r.rerun}`);
      return results;
    },
    guardRearm({ pr }) {
      try {
        const facts = readPrClearanceFacts({ repo, pr, runGh });
        return decideRearmGuard({ ...facts, record: latestAcceptRecord(facts.comments), setting: setting('rearmRequiresHeadChange') });
      } catch (e) { return { refuse: false, why: `guard error: ${e.message}` }; }
    },
  };
}
