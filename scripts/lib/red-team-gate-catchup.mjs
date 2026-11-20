import {
  liveResultGateState, planRedTeamActions, readConfirmedBreaks, readRedTeamDisposition, parseRedTeamGateMarker, redTeamResultCommentForHead,
} from './red-team-gate.mjs';
import { parseLatestHumanClearedSha } from './review-escalation.mjs';
import { commentCreatedAt } from '../conveyor/round-extension-mark.mjs';
import { runRedTeamGateForPr } from '../operations/extend-rounds-io.mjs';
import { standingRulingScope } from '../conveyor/standing-ruling-io.mjs';
import { publishAttention } from '../operations/needs-you-feed.mjs';
import { isTrustedMarkerAuthor } from './marker-authorship.mjs';
import { isHumanOperatorComment } from './operator-identity.mjs';

// Catch-up yields the whole result to the operator path, even if a ruling only
// covers one finding or is no longer the winning disposition. Only readable,
// trusted records can establish that ownership.
function hasRulingOrRelease(comments, pr, head, resultId, disposition, ignored, resultIndex = -1) {
  if (!(disposition?.rulings instanceof Map)) return true;
  for (const evidence of disposition.rulings.values()) {
    if (!Array.isArray(evidence) || evidence.some(r => r?.source === 'operator'
      || ['card', 'not-real', 'clear-human'].includes(r?.kind))) return true;
  }
  for (const [index, c] of comments.entries()) {
    if (typeof c?.body !== 'string') { ignored(index, 'malformed'); continue; }
    const body = c.body;
    // A legacy record (no result=) only covers results posted before it; a newer result is decided on its own.
    const olderThanResult = index < resultIndex;
    if (!olderThanResult && isHumanOperatorComment(c) && parseLatestHumanClearedSha([c]) === head.toLowerCase()) return true;
    if (!body.includes('we:red-team-gate')) continue;
    if (!isTrustedMarkerAuthor(c)) { ignored(index, 'untrusted'); continue; }
    const gate = parseRedTeamGateMarker(body);
    if (!gate) { ignored(index, 'malformed'); continue; }
    if (gate.outcome.startsWith('operator-') && !isHumanOperatorComment(c)) { ignored(index, 'untrusted'); continue; }
    if (gate.pr !== pr || gate.rev !== head.toLowerCase() || (gate.result && gate.result !== resultId)) continue;
    if (!gate.result && olderThanResult) continue;
    if (gate.outcome.startsWith('operator-') || gate.outcome === 'card-queued'
      || /finding\(s\) (?:filed as a follow-up card|carded by the operator|left advisory)/.test(body)) return true;
  }
  return false;
}

/** Nominate at most one owed send-back; shared disposition and grant-scope readers verify the supplied evidence. */
export function planGateCatchUp({ repo, refusals = [], rawPrs = [], now = Date.now(), history = new Map(),
  graceMin = 15, cooldownMin = 10, setting, log = () => {}, readDisposition = readRedTeamDisposition,
  readGrantScope = ({ repo, pr, head, comments }) => standingRulingScope({ repo, pr: { number: pr, headRefOid: head, comments } }) } = {}) {
  if (!Number.isFinite(now) || !Number.isFinite(graceMin) || graceMin < 15
    || !Number.isFinite(cooldownMin) || cooldownMin < 10) return [];
  for (const refusal of refusals) {
    if (refusal?.kind !== 'already-reviewed-head') continue;
    const pr = Number(refusal.prNumber), head = refusal.headSha;
    const slug = repo ?? refusal.repo;
    if (typeof slug !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(slug)
      || !Number.isSafeInteger(pr) || pr <= 0 || typeof head !== 'string' || !/^[0-9a-f]{40}$/i.test(head)) continue;
    const row = rawPrs.find(row => Number(row?.number) === pr);
    if (!row || row.headRefOid !== head || !Array.isArray(row.comments)) continue;
    let standingRuling = null;
    try { standingRuling = readGrantScope({ repo: slug, pr, head, comments: row.comments }) ?? null; } catch { /* Credit no automatic grant. */ }
    const state = liveResultGateState(row.comments, pr, head, slug, standingRuling);
    if (!state.result) continue;
    let disposition;
    try { disposition = readDisposition({ comments: row.comments, repo: slug, pr, head, setting, standingRuling }); }
    catch { continue; } // Unknown rulings cannot authorize another action.
    const ignored = (index, reason) => {
      const key = `${slug}#${pr}@${head.toLowerCase()}:ignored-gate:${index}:${reason}`;
      if (history.has(key)) return;
      history.set(key, { ignored: true });
      try { log(`red-team gate catch-up: ${slug}#${pr} ignored ${reason} gate record at comment ${index}`); } catch { /* Diagnostics never stop recovery. */ }
    };
    const hit = redTeamResultCommentForHead(row.comments, pr, head);
    const resultIndex = hit?.commentIndex ?? -1;
    if (hasRulingOrRelease(row.comments, pr, head, state.resultId, disposition, ignored, resultIndex)) continue;
    const plan = planRedTeamActions(state.result, setting);
    if (!(disposition?.dispositions instanceof Map)
      || state.result.findings.some(f => !Array.isArray(disposition.rulings.get(f.index))
        || !['open', 'held'].includes(disposition.dispositions.get(f.index)?.state))) continue;
    if (!plan.sendBack.length || (state.sendBackOutcome && !state.reopened)) continue;
    // Send-backs are safety maintenance even in mixed plans. The live gate admits
    // new card work separately, after recording the send-back.
    // Use the shared trusted reader: a carried result takes its carry comment's creation time.
    const at = Date.parse(commentCreatedAt(hit?.comment));
    if (!Number.isFinite(at) || now - at < graceMin * 60_000) continue;
    const key = `${slug}#${pr}@${head.toLowerCase()}:${state.resultId}`;
    const previous = history.get(key);
    if (previous && ((previous.terminal && !(state.reopened && previous.settled)) || !Number.isFinite(previous.lastAt) || now - previous.lastAt < cooldownMin * 60_000)) continue;
    return [{ repo: slug, pr, head, resultId: state.resultId, key }];
  }
  return [];
}

const retryable = new Set(['send-back-failed', 'send-back-record-failed', 'send-back-wrong-head']);
const settled = new Set(['applied', 'already-acted', 'head-moved', 'no-red-team-on-head', 'advisory-only']);

/** Synchronous like runRedTeamGateForPr. All effects are injected; no failure may escape into the daemon tick. */
export function runGateCatchUp({ runGate = runRedTeamGateForPr, needsYou = publishAttention, log = () => {},
  history = new Map(), now = Date.now(), setting, ...input } = {}) {
  const note = line => { try { log(line); } catch { /* Diagnostics never stop recovery. */ } };
  try {
    const picks = planGateCatchUp({ ...input, history, now, log: note, setting: setting ?? readConfirmedBreaks().value });
    const pick = picks[0];
    if (!pick) return { picks: [] };
    const previous = history.get(pick.key) ?? { attempts: 0, alerted: false };
    const retry = { ...previous, lastAt: now };
    history.set(pick.key, retry);
    let result;
    try { result = runGate({ repo: pick.repo, pr: pick.pr }); }
    catch { result = { status: 'error' }; }
    retry.terminal = !retryable.has(result?.status);
    retry.settled = settled.has(result?.status);
    retry.attempts = settled.has(result?.status) ? 0 : previous.attempts + 1;
    note(`red-team gate catch-up: ${pick.repo}#${pick.pr} ${settled.has(result?.status) ? 'settled' : retry.terminal ? 'failed; stopped for operator review' : 'failed; retry after cooldown'}`);
    if (!settled.has(result?.status) && (retry.terminal || retry.attempts >= 3) && !retry.alerted) {
      try {
        needsYou({ repo: pick.repo, pr: pick.pr, head: pick.head, result: pick.resultId,
          kind: 'red-team-gate-stuck', title: '',
          reason: retry.terminal
            ? `red-team gate stopped with status=${result?.status ?? 'unknown'} for result=${pick.resultId}; operator review required before another attempt`
            : `red-team gate failed ${retry.attempts} times for result=${pick.resultId}; retrying every 10 minutes` });
        retry.alerted = true;
      } catch { note(`red-team gate catch-up: ${pick.repo}#${pick.pr} needs-you publication failed`); }
    }
    return { picks, result };
  } catch {
    note('red-team gate catch-up failed; retry next tick');
    return { picks: [], status: 'error' };
  }
}
