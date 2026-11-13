/** Recover only a missing-red-team HOLD whose head-bound inputs have changed. */
import { latestFailingMergeGate, readMergeGateVerdict } from '../lib/merge-gate-hold-class.mjs';
import { GATE_IDS } from '../lib/merge-gate-inventory.mjs';
import { readRedTeamGateSource, readRedTeamCheckFact, resolveWeAppId } from '../lib/red-team-check-run.mjs';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { standDownComments } from './stand-down.mjs';
import { loadFlakeHoldState } from './load-flake-hold.mjs';

// Any live hold on this head blocks an automatic rerun: stand-downs (all kinds) and live load-flake holds.
const holdOnHead = (comments, headSha) => standDownComments(comments, { headRefOid: headSha }).length > 0
  || loadFlakeHoldState({ comments, headRefOid: headSha }).live;
import { runGhSync } from '../lib/gh-throttle.mjs';
import { readCompletePrComments } from './pr-comments-complete.mjs';

const MARKER = '<!-- we:merge-gate-input-rerun -->';
const MISSING = 'no red-team check run on head';
const statuses = new Set(['pass', 'hold', 'fail-closed', 'queue', 'enqueue', 'skipped-by-policy']);
const gates = new Set(GATE_IDS);
const sameHead = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const jobIdOf = row => Number(/\/actions\/runs\/\d+\/job\/(\d+)/.exec(row?.detailsUrl ?? row?.details_url ?? '')?.[1] ?? row?.id);
const errorText = e => String(e?.message ?? e).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 300);

const rollupRefusal = pr => !Array.isArray(pr?.statusCheckRollup)
  ? 'unreadable status check rollup; operator must inspect full checks'
  : pr.statusCheckRollup.length >= 100
    ? 'status check rollup incomplete at 100-context bound; operator must inspect full checks and rerun manually'
    : null;

function matchesReservation(comment, headSha, inputKey) {
  if (!isTrustedMarkerAuthor(comment) || typeof comment?.body !== 'string') return false;
  const lines = comment.body.trimStart().split(/\r?\n/);
  return lines[0] === MARKER && lines.includes(`head: ${headSha}`) && lines.includes(`input: ${inputKey}`);
}

// The complete REST reader replaces id with node_id; html_url retains the numeric creation order.
function commentOrderId(comment) {
  const id = String(comment?.id ?? '');
  const numeric = /^[1-9]\d*$/.test(id) ? id : /#issuecomment-([1-9]\d*)$/.exec(comment?.html_url ?? '')?.[1];
  return numeric ? BigInt(numeric) : null;
}

function confirmReservation(reservation, comments, { headSha, inputKey }) {
  const fallback = 'unprovable marker reservation; operator must inspect full thread';
  if (!Array.isArray(comments)) throw Error(fallback);
  const matches = comments.filter(c => matchesReservation(c, headSha, inputKey));
  const ids = c => [c?.id, c?.node_id, commentOrderId(c)].filter(id => id != null).map(String);
  const own = matches.filter(c => ids(c).some(id => ids(reservation).includes(id)));
  if (own.length !== 1) throw Error(fallback);
  for (const other of matches) {
    if (other === own[0]) continue;
    const a = commentOrderId(other), b = commentOrderId(own[0]);
    if (a !== null && b !== null && a !== b) {
      if (a < b) return false;
      continue;
    }
    const earlier = Date.parse(other.created_at ?? other.createdAt);
    const current = Date.parse(own[0].created_at ?? own[0].createdAt);
    if (!Number.isFinite(earlier) || !Number.isFinite(current) || earlier === current) throw Error(fallback);
    if (earlier < current) return false;
  }
  return true;
}

/** Pure: callers supply trusted red-team facts, never raw unverified check runs. */
export function planMergeGateInputRerun(pr, { verdict, setting, redTeamFact, comments } = {}) {
  const result = { dispatch: [], refusals: [], applied: [] };
  const refuse = why => { result.refusals.push({ prNumber: pr?.number, why }); return result; };
  const incomplete = rollupRefusal(pr);
  if (incomplete) return refuse(incomplete);
  const row = latestFailingMergeGate(pr?.statusCheckRollup);
  if (!row || String(row.conclusion).toLowerCase() !== 'failure') return result;
  const jobId = jobIdOf(row);
  if (!Number.isSafeInteger(jobId) || jobId <= 0 || !Number.isSafeInteger(pr?.number)
    || !/^[a-f0-9]{40}$/i.test(pr?.headRefOid ?? '')) return refuse('invalid PR head or merge-gate job identity');
  if (!verdict || verdict.error || verdict.num !== pr.number || verdict.ok !== false
    || !sameHead(verdict.head_sha, pr.headRefOid)) return refuse('unreadable or stale-head verdict');
  const rows = verdict.results;
  if (!Array.isArray(rows) || !rows.length || rows.some(r => !r || !statuses.has(r.status) || !gates.has(r.id)))
    return refuse('unreadable verdict rows');
  const blocking = rows.filter(r => r.status === 'hold' || r.status === 'fail-closed');
  if (!blocking.length || blocking.some(r => r.id !== 'red-team' || r.status !== 'hold' || r.reason !== MISSING)
    || rows.some(r => r.id === 'red-team' && (r.status !== 'hold' || r.reason !== MISSING)))
    return refuse('verdict is not exclusively the missing-red-team hold');
  if (!Array.isArray(comments)) return refuse('unreadable marker history; operator must inspect full thread');
  let inputKey;
  if (setting?.value?.source === 'drain-scan') inputKey = 'source:drain-scan';
  else {
    const run = redTeamFact?.checkRun;
    // A completed trusted failure also changes the missing input; rerunning exposes that real hold.
    if (run && (redTeamFact.ok === true || /^red-team check run failed \(/.test(redTeamFact.reason ?? ''))
      && run.name === 'red-team' && sameHead(run.head_sha, pr.headRefOid) && run.status === 'completed'
      && Number.isSafeInteger(run.id) && run.id > 0
      && Number.isFinite(Date.parse(verdict.completed_at)) && Number.isFinite(Date.parse(run.completed_at))
      && Date.parse(run.completed_at) > Date.parse(verdict.completed_at)) inputKey = `redteam:${run.id}`;
  }
  if (!inputKey) return refuse('no changed input proven');
  const headSha = pr.headRefOid.toLowerCase();
  if (holdOnHead(comments, headSha)) return refuse('unresolved hold or stand-down on this head requires operator resolution');
  if (comments.some(c => matchesReservation(c, headSha, inputKey))) return refuse('head/input already reserved');
  result.dispatch.push({ prNumber: pr.number, jobId, headSha, inputKey });
  return result;
}

const ioOptions = { encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] };

/** Retain metadata from the SAME response the shared trusted reader evaluated. */
function defaultReadRedTeam({ repo, pr, headSha, gh, log }) {
  const app = resolveWeAppId({ log });
  let runs;
  const fact = readRedTeamCheckFact({ repo, pr, headSha, appId: app.appId, gh: (args, options) => {
    const raw = gh(args, options);
    runs = JSON.parse(raw)?.check_runs;
    return raw;
  } });
  if (fact.ok !== true && !/^red-team check run failed \(/.test(fact.reason ?? '')) return fact;
  const checkRun = runs.filter(r => r.name === 'red-team' && sameHead(r.head_sha, headSha)
    && Number(r.app?.id) === Number(app.appId) && r.external_id === `${repo}#${pr}`)
    .sort((a, b) => b.id - a.id)[0];
  return { ...fact, checkRun };
}

function etTimestamp(value) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(value).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ET`;
}

/** Synchronous IO shell, matching the watch's runPass contract. All IO is replaceable. */
export function sweepMergeGateInputRerun({ repo, apply = false, readOpenPrs, readVerdict, readSetting,
  readRedTeam, readComments, rerunJob, postComment, now = () => new Date(), log = console.error } = {}) {
  let calls = 0;
  const gh = (args, options = {}) => {
    if (++calls > 128) throw Error('merge-gate input rerun call budget exceeded; operator must inspect remaining PRs');
    return runGhSync(args, { ...ioOptions, ...options });
  };
  repo ??= JSON.parse(gh(['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw Error('invalid repository');
  readOpenPrs ??= () => JSON.parse(gh(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100',
    '--json', 'number,headRefOid,statusCheckRollup']));
  readVerdict ??= args => readMergeGateVerdict({ ...args, runGh: gh });
  readSetting ??= () => readRedTeamGateSource({ log });
  readRedTeam ??= args => defaultReadRedTeam({ ...args, gh, log });
  readComments ??= number => readCompletePrComments(number, { repo, gh: args => JSON.parse(gh(args)) });
  rerunJob ??= ({ jobId }) => { gh(['api', `repos/${repo}/actions/jobs/${jobId}/rerun`, '-X', 'POST']); return { ok: true }; };
  postComment ??= (number, { body }) => {
    const url = String(gh(['pr', 'comment', String(number), '--repo', repo, '--body', body])).trim().split('\n').pop();
    return { html_url: url, id: /#issuecomment-([1-9]\d*)$/.exec(url)?.[1] };
  };
  const result = { dispatch: [], refusals: [], applied: [] };
  const prs = readOpenPrs({ repo });
  if (!Array.isArray(prs) || prs.length >= 100) throw Error('open PR listing incomplete at 100-PR bound; operator must inspect full listing');
  const setting = readSetting({ repo, log });
  for (const pr of prs) {
    const incomplete = rollupRefusal(pr);
    if (incomplete) {
      result.refusals.push({ prNumber: pr.number, why: incomplete });
      continue;
    }
    const row = latestFailingMergeGate(pr.statusCheckRollup);
    if (!row || String(row.conclusion).toLowerCase() !== 'failure') continue;
    try {
      const verdict = readVerdict({ repo, jobId: jobIdOf(row), prNumber: pr.number });
      const redTeamFact = setting?.value?.source === 'drain-scan' ? null
        : readRedTeam({ repo, pr: pr.number, headSha: pr.headRefOid });
      const comments = readComments(pr.number, { repo });
      const plan = planMergeGateInputRerun(pr, { verdict, setting, redTeamFact, comments });
      result.dispatch.push(...plan.dispatch);
      result.refusals.push(...plan.refusals);
      for (const action of plan.dispatch) {
        if (!apply) continue;
        const reservation = postComment(pr.number, { repo, body: `${MARKER}\nhead: ${action.headSha}\ninput: ${action.inputKey}\nMerge-gate job ${action.jobId} rerun reserved.` });
        if (reservation?.ok === false) throw Error('marker reservation failed');
        const after = readComments(pr.number, { repo });
        if (Array.isArray(after) && holdOnHead(after, action.headSha)) {
          result.refusals.push({ prNumber: pr.number, why: 'hold or stand-down appeared after reservation; operator resolution required' });
          continue;
        }
        if (!confirmReservation(reservation, after, action)) {
          result.refusals.push({ prNumber: pr.number, why: 'lost-reservation' });
          continue;
        }
        let outcome;
        try { outcome = rerunJob({ repo, ...action }); }
        catch (error) { outcome = { ok: false, error: errorText(error) }; }
        const applied = { ...action, ok: outcome?.ok !== false, ...(outcome?.error ? { error: errorText(outcome.error) } : {}) };
        result.applied.push(applied);
        log(`merge-gate-input-rerun: PR #${pr.number} job ${action.jobId} ${applied.ok ? 'rerun' : 'rerun failed'} (input=${action.inputKey}) at ${etTimestamp(now())}`);
        postComment(pr.number, { repo, body: `merge-gate-input-rerun: job ${action.jobId} ${applied.ok ? 'rerun requested' : `rerun failed: ${applied.error ?? 'request refused'}`} (head=${action.headSha}, input=${action.inputKey}). Reservation remains consumed.` });
      }
    } catch (error) {
      result.refusals.push({ prNumber: pr.number, why: errorText(error) });
    }
  }
  return result;
}

export function formatMergeGateInputRerunReport({ dispatch = [], refusals = [], applied = [] } = {}) {
  return [`merge-gate-input-rerun: ${dispatch.length} dispatch, ${refusals.length} refusal(s), ${applied.length} applied`,
    ...refusals.map(r => `PR #${r.prNumber}: ${r.why}`)].join('\n');
}
