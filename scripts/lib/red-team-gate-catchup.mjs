import {
  liveResultGateState, planRedTeamActions, readConfirmedBreaks, redTeamGateOwed, redTeamResultCommentForHead,
} from './red-team-gate.mjs';
import { commentCreatedAt } from '../conveyor/round-extension-mark.mjs';
import { runRedTeamGateForPr } from '../operations/extend-rounds-io.mjs';
import { publishAttention } from '../operations/needs-you-feed.mjs';

/** Nominate at most one owed gate from already-read evidence; no GitHub reads or history mutation. */
export function planGateCatchUp({ repo, refusals = [], rawPrs = [], now = Date.now(), history = new Map(),
  graceMin = 15, cooldownMin = 10, setting } = {}) {
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
    const state = liveResultGateState(row.comments, pr, head, slug);
    if (!state.result) continue;
    const plan = planRedTeamActions(state.result, setting);
    if (!redTeamGateOwed(state, plan)) continue;
    // Use the shared trusted reader: a carried result takes its carry comment's creation time.
    const hit = redTeamResultCommentForHead(row.comments, pr, head);
    const at = Date.parse(commentCreatedAt(hit?.comment));
    if (!Number.isFinite(at) || now - at < graceMin * 60_000) continue;
    const key = `${slug}#${pr}@${head.toLowerCase()}:${state.resultId}`;
    const previous = history.get(key);
    if (previous && (!Number.isFinite(previous.lastAt) || now - previous.lastAt < cooldownMin * 60_000)) continue;
    return [{ repo: slug, pr, head, resultId: state.resultId, key }];
  }
  return [];
}

const settled = new Set(['applied', 'already-acted', 'head-moved', 'no-red-team-on-head', 'advisory-only']);

/** Synchronous like runRedTeamGateForPr. All effects are injected; no failure may escape into the daemon tick. */
export function runGateCatchUp({ runGate = runRedTeamGateForPr, needsYou = publishAttention, log = () => {},
  history = new Map(), now = Date.now(), setting, ...input } = {}) {
  const note = line => { try { log(line); } catch { /* Diagnostics never stop recovery. */ } };
  try {
    const picks = planGateCatchUp({ ...input, history, now, setting: setting ?? readConfirmedBreaks().value });
    const pick = picks[0];
    if (!pick) return { picks: [] };
    const previous = history.get(pick.key) ?? { attempts: 0, alerted: false };
    const retry = { ...previous, lastAt: now };
    history.set(pick.key, retry);
    let result;
    try { result = runGate({ repo: pick.repo, pr: pick.pr }); }
    catch { result = { status: 'error' }; }
    retry.attempts = settled.has(result?.status) ? 0 : previous.attempts + 1;
    note(`red-team gate catch-up: ${pick.repo}#${pick.pr} ${settled.has(result?.status) ? 'settled' : 'failed; retry after cooldown'}`);
    if (retry.attempts >= 3 && !retry.alerted) {
      try {
        needsYou({ repo: pick.repo, pr: pick.pr, head: pick.head, result: pick.resultId,
          kind: 'red-team-gate-stuck', title: '',
          reason: `red-team gate failed ${retry.attempts} times for result=${pick.resultId}; retrying every 10 minutes` });
        retry.alerted = true;
      } catch { note(`red-team gate catch-up: ${pick.repo}#${pick.pr} needs-you publication failed`); }
    }
    return { picks, result };
  } catch {
    note('red-team gate catch-up failed; retry next tick');
    return { picks: [], status: 'error' };
  }
}
