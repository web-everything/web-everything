/** Shared success-rate evidence for every deciding seat and provider. Read-only aggregation. */
import { join } from 'node:path';
import { daemonConveyorStateRoot } from './daemon-last-good.mjs';
import { appendShadowRow, readShadowRows } from './review-shadow-agreement.mjs';
import { buildPromotionReport } from './review-carbon-promotion.mjs';
import { deriveVerdict, findingIdentityEntry, normalizeFindings } from './jury-core.mjs';
import { vendorOfModel } from './review-seat-provider.mjs';

export const seatLedgerPath = (env = process.env) => join(daemonConveyorStateRoot(env), '.conveyor', 'review-seat-success.jsonl');
export const appendSeatAttempt = (row, io = {}) => appendShadowRow(row, { path: seatLedgerPath(), ...io });
export const readSeatAttempts = (io = {}) => readShadowRows({ path: seatLedgerPath(), ...io });
const providerFor = model => ({ Google: 'agy-gemini', Anthropic: 'claude', OpenAI: 'codex' })[vendorOfModel(model)] ?? 'unknown';
export function seatAttempt(request, outcome, error, at = new Date().toISOString()) {
  const answer = outcome?.value;
  const model = outcome?.telemetry?.model ?? answer?.seatProvider?.model ?? request.seatProvider?.model ?? request.model;
  const status = !error && answer && !answer.skipped && !outcome?.telemetry?.timedOut ? 'ok' : 'failed';
  return { at, ...request.reviewContext, body: undefined, headMessage: undefined,
    runId: request.runId, lens: request.lens, provider: answer?.seatProvider?.provider === 'agy' && vendorOfModel(model) === 'Anthropic' ? 'agy-claude' : providerFor(model), model, status,
    deciding: ['correctness', 'security'].includes(request.lens),
    timeout: outcome?.telemetry?.timedOut === true || error?.timedOut === true || error?.telemetry?.timedOut === true
      || /tim(?:e|ed)[ -]?out/i.test(`${error?.name ?? ''} ${error?.message ?? ''}`),
    reasons: error ? [String(error.message).slice(0, 300)] : [],
    agyVerdict: status === 'ok' ? deriveVerdict(answer) : null,
    agyFindings: status === 'ok' ? normalizeFindings(answer.findings).map((f, i) => ({ ...findingIdentityEntry(f, String(i)), line: f.line ?? null })) : [],
  };
}

/** Aggregate historical scorecards beside the new deciding-seat attempts; missing judgments stay pending. */
export function buildSeatSuccessReport({ rows, scorecards = [], runRecords = new Map(), prRuns = new Map() }) {
  const historical = scorecards.filter(r => r.dispatchKind === 'review-seat' && r.lens && !r.discarded && !r.quotaObservation).map(r => ({
    ...r, head: r.rev, deciding: r.lens === 'red-team', agyVerdict: r.seatVerdict,
    agyFindings: [], timeout: /timeout|timed.out/.test(`${r.status} ${r.error ?? ''}`),
  }));
  const all = [...rows, ...historical];
  const summarize = group => {
    const summary = buildPromotionReport({ rows: group, runRecords, prRuns });
    summary.countedVerdicts = group.filter(r => r.status === 'ok' && r.deciding === true && r.agyVerdict != null).length;
    for (const row of group.filter(r => Object.hasOwn(r, 'seatVerdict'))) {
      if (row.status === 'ok' && row.seatVerdict && row.claudeVerdict) {
        summary.agreement.compared++;
        if (row.seatVerdict === row.claudeVerdict) summary.agreement.agree++;
      }
      summary.confirmedFindings += (row.findings ?? []).filter(f => f.confirmedByRecheck === true).length;
      summary.falsePositives += (row.findings ?? []).filter(f => f.recheckOutcome === 'not-real' || (f.recheckOutcome === 'not confirmed' && f.filesRead?.length > 0)).length;
    }
    summary.agreement.rate = summary.agreement.compared ? summary.agreement.agree / summary.agreement.compared : null;
    return summary;
  };
  const grouped = key => Object.fromEntries([...new Set(all.map(key))].sort().map(k => [k, summarize(all.filter(r => key(r) === k))]));
  return { bySeat: grouped(r => r.lens), byProvider: grouped(r => r.provider ?? providerFor(r.model)),
    bySeatAndProvider: grouped(r => `${r.lens}/${r.provider ?? providerFor(r.model)}`) };
}
