/** Preserve a trusted clearance when a repair dispatch has not moved the head. */
import { isCandidacyHold, readMergeGateVerdict } from './merge-gate-hold-class.mjs';
import { REVIEW_CLEARANCE_SETTINGS, resolveReviewClearanceSetting, loadReviewClearanceSetting } from './review-clearance-settings.mjs';

export { REVIEW_CLEARANCE_SETTINGS, resolveReviewClearanceSetting, loadReviewClearanceSetting };
import { latestAcceptRecord, isKnownMachineBody, laterReviewHold } from './accept-carry-forward.mjs';
import { isTrustedMarkerAuthor, isAutomationAuthored } from './marker-authorship.mjs';
import { parseLatestHumanClearedSha, isAcceptRecordBody } from './review-escalation.mjs';
import { collapseRollupToLatestPerName } from './rollup-collapse.mjs';
import { FAILING_CONCLUSIONS } from '../operations/pr-status.mjs';
import { runGhSync } from './gh-throttle.mjs';
import { isGhDeferred } from './gh-deferred.mjs';

let sweepOffset = 0;
export const REARM_MARKER = '🔧 conveyor fix — re-armed for re-review';
const RESTORE_MARKER = '🔔 conveyor — review clearance restored (no push since the clearance)';
const holds = ['review:human', 'review:pending', 'review:changes', 'review:held-mechanical'];
/** One `gh pr edit` swap: its unlabel and label events can be stamped a few seconds apart. */
const SWAP_SKEW_MS = 10_000;
const enabled = setting => (typeof setting === 'string' ? setting : setting?.value) === 'on';
const names = labels => Array.isArray(labels) ? labels.map(l => typeof l === 'string' ? l : l?.name) : [];
const at = c => c?.createdAt ?? c?.created_at;
const starts = (c, marker) => typeof c?.body === 'string' && c.body.split(/\r?\n/)[0].startsWith(marker);
const sameHead = (record, prHead, refHead) => /^[0-9a-f]{40}$/.test(record?.sha ?? '') && record.sha === prHead && record.sha === refHead;
const jobIdOf = row => Number(/\/job\/(\d+)/.exec(row?.detailsUrl ?? row?.details_url ?? '')?.[1] ?? row?.id);
const failing = row => FAILING_CONCLUSIONS.includes(String(row?.conclusion ?? row?.state).toLowerCase());
/** Could this comment hold a clearance? Anything but a known machine note or the trusted approval-prevention notice. */
const holdsClearance = c => !isKnownMachineBody(c?.body)
  && !(isTrustedMarkerAuthor(c) && typeof c?.body === 'string' && c.body.trimStart().startsWith('<!-- approval-prevention-filed:'));
/**
 * The latest trusted `reviewed-sha` record, only when that comment IS an acceptance (PR #5237 round 5). A revocation
 * that quotes the marker is the latest record too, and it is not a clearance: null, so nothing is restored or
 * protected from it, and a newer marker-bearing comment of any other kind never lets an older acceptance through.
 */
const latestAcceptance = comments => {
  const record = latestAcceptRecord(comments);
  return record && isAcceptRecordBody(comments[record.index]?.body) ? record : null;
};

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
  const record = latestAcceptance(comments);
  if (!sameHead(record, prHead, refHead) || !Number.isFinite(Date.parse(record?.at))) return no('same head clearance unproven');
  if (!Array.isArray(reviews) || laterReviewHold(reviews, record.at)) return no('formal reviews unreadable or hold clearance');
  if (!Array.isArray(events)) return no('issue events unreadable');
  const later = comments.slice(record.index + 1);
  const rearms = later.filter(c => starts(c, REARM_MARKER) && isTrustedMarkerAuthor(c) && Date.parse(at(c)) > Date.parse(record.at));
  const rearmComment = rearms.at(-1);
  if (!rearmComment) return no('no later trusted re-arm');
  if (later.some(c => starts(c, RESTORE_MARKER) && isTrustedMarkerAuthor(c)
    && c.body.includes(prHead) && Date.parse(at(c)) > Date.parse(at(rearmComment)))) return no('restoration already recorded');
  if (later.some(c => !rearms.includes(c) && holdsClearance(c))) return no('intervening comment holds clearance');
  const removals = events.filter(e => e.event === 'unlabeled' && e.label?.name === 'review:accepted');
  if (removals.some(e => !Number.isFinite(Date.parse(at(e))))) return no('unlabel event time unreadable');
  // The re-arm's swap must be the ONLY removal since the clearance. A second one means the acceptance was granted
  // again and taken away again: a later decision, whoever made it and however close in time (PR #5237 round 4).
  const sinceClearance = removals.filter(e => Date.parse(at(e)) > Date.parse(record.at));
  if (sinceClearance.length > 1) return no('acceptance removed more than once since the clearance');
  const removal = sinceClearance[0];
  const login = removal?.actor?.login;
  if (!login || !isAutomationAuthored({ author: { login } })
    || !rearms.some(c => Math.abs(Date.parse(at(c)) - Date.parse(at(removal))) <= 180_000)) return no('accepted removal not tied to trusted re-arm');
  // Exactly one hold event is exempt: the swap's own automated `labeled review:pending`, the first one within a few
  // seconds of the removal (GitHub can stamp it a second apart). It is chosen by position, never by actor identity,
  // so any further hold label after the clearance — by the same identity or another — still revokes.
  const swapPending = events.find(e => e.event === 'labeled' && e.label?.name === 'review:pending'
    && Math.abs(Date.parse(at(e)) - Date.parse(at(removal))) <= SWAP_SKEW_MS
    && isAutomationAuthored({ author: { login: e.actor?.login ?? '' } }));
  if (events.some(e => e.event === 'labeled' && holds.includes(e.label?.name)
    && (!Number.isFinite(Date.parse(at(e))) || Date.parse(at(e)) > Date.parse(record.at))
    && e !== swapPending)) return no('intervening label hold');
  return { restore: true, record: { ...record, url: comments[record.index]?.url }, rearmComment, why: 'trusted no-push re-arm removed the original clearance' };
}

export function buildRestoreComment({ head, record, rearm, setting }) {
  return `${RESTORE_MARKER}\n\nHead: ${head}. Original clearance carried from ${record.url} at ${record.at}.\nRe-arm: ${rearm.url} at ${at(rearm)} removed \`review:accepted\` with no push (the head is still the cleared head).\nNo new verdict or acceptance marker is written; the original clearance record above stands.\nreviewClearance.restoreNoPushRearm=${typeof setting === 'string' ? setting : setting.value} (source: ${setting.source ?? 'standard'}).`;
}

/** Cheap pre-check (comments only): is there a trusted re-arm after a same-sha accept record, not yet restored? */
export function mayNeedRestore({ comments, prHead } = {}) {
  const record = latestAcceptance(comments);
  if (!record || record.sha !== prHead) return false;
  const later = comments.slice(record.index + 1);
  const last = later.map((c, i) => [c, i]).filter(([c]) => starts(c, REARM_MARKER) && isTrustedMarkerAuthor(c)).at(-1);
  return !!last && !later.slice(last[1] + 1).some(c => starts(c, RESTORE_MARKER) && isTrustedMarkerAuthor(c));
}

const readJson = (runGh, repo, args) => {
  try { return JSON.parse(runGh(args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], throttle: { op: 'review-clearance-read', repo } })); }
  catch { return null; }
};

/** Both live heads, read fresh (PR view, then the branch ref); null for any read that fails or disagrees on the branch. */
export function readLiveHeads({ repo, pr, runGh = runGhSync, headRefName }) {
  const view = readJson(runGh, repo, ['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid,headRefName']);
  const name = view?.headRefName;
  const ref = name ? readJson(runGh, repo, ['api', `repos/${repo}/git/ref/heads/${name}`]) : null;
  return { prHead: name && name === headRefName ? view?.headRefOid ?? null : null, refHead: ref?.object?.sha ?? null };
}

/** The PR's whole comment thread, in the shape the deciders read; null when any page fails (never a partial list). */
export function readPrComments({ repo, pr, runGh = runGhSync }) {
  const pages = readJson(runGh, repo, ['api', '--paginate', '--slurp', `repos/${repo}/issues/${pr}/comments?per_page=100`]);
  return Array.isArray(pages)
    ? pages.flat().map(c => ({ body: c.body, createdAt: c.created_at, author: { login: c.user?.login ?? '' }, url: c.html_url }))
    : null;
}

/**
 * PR #5237 round 5: after a post-write head move, has a NEWER acceptance been recorded for the live head (a push and
 * a fresh clear-human landing during the restoration)? Then `review:accepted` is that acceptance's label, not ours,
 * and the rollback must leave it. It must be the latest acceptance record, trusted, name both live heads, be newer
 * than the record we restored from, and have no comment after it that could hold it. A label decision leaves no
 * comment, so no `review:accepted` removal and no hold label may follow it either, and no hold label may stand now
 * (`labels`: the live labels after our write). Anything unreadable is false.
 */
export function newerAcceptanceOnHead({ comments, events, labels, record, prHead, refHead } = {}) {
  if (!Array.isArray(comments) || !Array.isArray(events) || !Array.isArray(labels)) return false;
  const latest = latestAcceptance(comments);
  if (!latest || !sameHead(latest, prHead, refHead) || !(Date.parse(latest.at) > Date.parse(record?.at))) return false;
  if (comments.slice(latest.index + 1).some(holdsClearance)) return false;
  if (names(labels).some(l => holds.includes(l))) return false;
  return !events.some(e => ((e.event === 'unlabeled' && e.label?.name === 'review:accepted')
    || (e.event === 'labeled' && holds.includes(e.label?.name)))
    && !(Date.parse(at(e)) < Date.parse(latest.at)));
}

/** Read the live thread, events and labels, then {@link newerAcceptanceOnHead}; any read failure or throw is false. */
function readNewerAcceptanceOnHead({ repo, pr, runGh, record, after }) {
  try {
    const pages = readJson(runGh, repo, ['api', '--paginate', '--slurp', `repos/${repo}/issues/${pr}/events?per_page=100`]);
    const view = readJson(runGh, repo, ['pr', 'view', String(pr), '--repo', repo, '--json', 'labels']);
    return newerAcceptanceOnHead({ comments: readPrComments({ repo, pr, runGh }), events: Array.isArray(pages) ? pages.flat() : null,
      labels: view?.labels ?? null, record, ...after });
  } catch { return false; }
}

export function readPrClearanceFacts({ repo, pr, runGh = runGhSync, full = true, revalidate = false }) {
  const read = args => readJson(runGh, repo, args);
  // Every list read is complete (`--paginate --slurp`, flattened); a failed read is null, never a partial list.
  const list = path => { const pages = read(['api', '--paginate', '--slurp', `${path}?per_page=100`]); return Array.isArray(pages) ? pages.flat() : null; };
  const view = read(['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid,headRefName,labels,statusCheckRollup']);
  const comments = view ? readPrComments({ repo, pr, runGh }) : null;
  const facts = { prHead: view?.headRefOid ?? null, refHead: null, labels: view?.labels ?? null, comments,
    rows: view?.statusCheckRollup ?? null, reviews: null, events: null };
  // `full: 'if-restore'` (the sweep) pays for reviews / events / the ref read only when a restore is plausible.
  if (!view || (full === 'if-restore' && !(comments && mayNeedRestore(facts)))) return facts;
  const readRef = () => view.headRefName ? read(['api', `repos/${repo}/git/ref/heads/${view.headRefName}`]) : null;
  let ref = revalidate ? null : readRef();
  const reviews = list(`repos/${repo}/pulls/${pr}/reviews`);
  const events = list(`repos/${repo}/issues/${pr}/events`);
  if (revalidate) {
    // List pagination can span a push or a new hold. Read both heads and live labels last,
    // immediately before the restore decision, rather than trusting the initial view.
    ref = readRef();
    const live = read(['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid,headRefName,labels,statusCheckRollup']);
    facts.prHead = live?.headRefName === view.headRefName ? live?.headRefOid ?? null : null;
    facts.labels = live?.labels ?? null;
    facts.rows = live?.statusCheckRollup ?? null;
  }
  return { ...facts, headRefName: view.headRefName ?? null, refHead: ref?.object?.sha ?? null, reviews, events };
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
    let restoration = decideClearanceRestore({ ...facts, setting: restoreSetting });
    let restored = false;
    if (restoration.restore) {
      const collectedHead = facts.prHead;
      Object.assign(facts, readPrClearanceFacts({ repo, pr, runGh, revalidate: true }));
      restoration = facts.prHead === collectedHead
        ? decideClearanceRestore({ ...facts, setting: restoreSetting })
        : { restore: false, why: 'head changed or unreadable during restoration validation' };
    }
    if (restoration.restore) {
      // A throw (deferral, timeout) does not prove the write was not applied, so the check below runs either way.
      let writeError = null;
      try { mutate(['pr', 'edit', String(pr), '--repo', repo, '--add-label', 'review:accepted', '--remove-label', 'review:pending']); }
      catch (e) { writeError = e; }
      // GitHub has no conditional label write, so a push can still land between the last read and the write above.
      // Read both heads again AFTER the write; if either moved or cannot be read, undo it at once (fail closed) and
      // record nothing, so the new head keeps `review:pending` and its re-review stays owed.
      const after = readLiveHeads({ repo, pr, runGh, headRefName: facts.headRefName });
      if (!sameHead(restoration.record, after.prHead, after.refHead)
        && readNewerAcceptanceOnHead({ repo, pr, runGh, record: restoration.record, after })) {
        // The head moved AND a newer acceptance of the live head was recorded meanwhile: the label is its now. A
        // clearance comment that lands only after this read is still rolled back (no conditional write exists): the
        // fail-closed side, a re-review owed, never an approval nobody granted.
        log(`review-clearance: PR #${pr} restoration superseded — a newer acceptance of ${after.prHead.slice(0, 9)} owns review:accepted; no rollback`);
        restoration = { restore: false, why: 'a newer acceptance of the live head was recorded during the restoration' };
      } else if (!sameHead(restoration.record, after.prHead, after.refHead)) {
        try { mutate(['pr', 'edit', String(pr), '--repo', repo, '--add-label', 'review:pending', '--remove-label', 'review:accepted']); }
        catch (e) { throw new Error(`restoration rollback failed after the head moved: ${e.message}`); }
        log(`review-clearance: PR #${pr} restoration undone — head moved or unreadable after the approval write`);
        restoration = { restore: false, why: 'head moved or unreadable after the approval write' };
      }
      if (writeError) throw writeError;
    }
    if (restoration.restore) {
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
      record: latestAcceptance(facts.comments), row, rows: facts.rows, verdict: row && failing(row) ? verdictFor(row) : null,
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
        return decideRearmGuard({ ...facts, record: latestAcceptance(facts.comments), setting: setting('rearmRequiresHeadChange') });
      } catch (e) { return { refuse: false, why: `guard error: ${e.message}` }; }
    },
  };
}
