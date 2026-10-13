/**
 * review-seat-runner.mjs — RUN ONE REVIEW SEAT ON THE PROVIDER ITS SETTING NAMES (card 84, review half).
 *
 * A `review-pr` judge request may carry `seatProvider: {mode, model, onEscape}` (built from
 * `review.seatProvider.<lens>`, `we:scripts/lib/review-seat-provider.mjs`). `createDefaultJudge`
 * (`./cli-adapter.mjs`) hands such a request here instead of spawning it directly:
 *
 *   - `shadow`  — the Claude juror runs and its answer is the seat's answer, unchanged. Then an agy juror runs the same
 *                 request in its own juror lane (`we:scripts/lib/agy-review-juror.mjs`). Its answer, its status and the
 *                 agreement with Claude are attached to the seat's answer as `shadow` (recorded on the run, never
 *                 reduced into the verdict) and appended per attempt to the agreement store
 *                 (`we:scripts/lib/review-shadow-agreement.mjs`). An agy failure or escape never touches the Claude
 *                 answer. A failed override is recorded before a loud retry on the routing-policy model;
 *                 a voided attempt is never retried.
 *   - `agy`     — the agy juror runs. Its answer becomes the seat's answer only when it finished, answered, and none of
 *                 the escape checks fired. Otherwise the seat FALLS BACK to Claude (`onEscape: 'claude'`), or — for an
 *                 advisory seat (`onEscape: 'skip'`) — is recorded as skipped, so an advisory seat never spends Claude.
 *
 * The two jurors run one after the other, never together: the escape check snapshots the review lane around the agy
 * run, and a Claude juror's own mutation probes in that same lane would read as an agy escape.
 *
 * Every answer this returns carries `seatProvider: {provider, ...}` so the run record says who actually judged.
 */
import { runAgyReviewJuror, scrubPaths } from '../lib/agy-review-juror.mjs';
import { appendShadowRow, buildShadowRow, compareShadowAnswers } from '../lib/review-shadow-agreement.mjs';
import { logReviewSeat } from '../lib/review-seat-provider.mjs';

/** The closed set of directive modes this runner accepts. */
export const SEAT_RUN_MODES = Object.freeze(['agy', 'shadow']);

/**
 * @param {object} request - the judge request, INCLUDING its `seatProvider` directive.
 * @param {object} io
 * @param {(request: object) => Promise<object>} io.claudeJudge - the ordinary judge (returns a judge outcome).
 * @param {(returned: object) => {value: object, telemetry: object|null}} io.unwrap
 * @param {(value: object, telemetry?: object|null) => object} io.wrap
 * @param {string|null} io.cwd - the review lane.
 * @param {Function} [io.agyJuror] - injectable for tests.
 * @param {Function} [io.appendRow] - injectable for tests.
 * @param {Function} [io.log] - stderr logger, injectable for tests.
 * @param {() => number} [io.now]
 */
export async function runSeatWithProvider(request, {
  claudeJudge, unwrap, wrap, cwd, agyJuror = runAgyReviewJuror, appendRow = appendShadowRow, now = () => Date.now(),
  log = (m) => console.error(m),
}) {
  const { seatProvider: directive, ...plain } = request;
  if (!directive || !SEAT_RUN_MODES.includes(directive.mode)) {
    throw new Error(`review-seat-runner: unknown seat provider mode ${JSON.stringify(directive?.mode)} — one of ${SEAT_RUN_MODES.join('|')}`);
  }
  const model = directive.model;
  const runAgy = async (runModel = model) => {
    try { return await agyJuror({ request: plain, laneCwd: cwd, model: runModel }); } catch (e) {
      // A thrown error's text reaches the run record and a skipped advisory seat's PR summary: no local paths there.
      return { status: 'failed', reasons: [scrubPaths(e?.message ?? e, [cwd])] };
    }
  };

  if (directive.mode === 'shadow') {
    const claude = unwrap(await claudeJudge(plain));
    let agyRun = await runAgy();
    const claudeSessionId = claude.telemetry?.sessionId ?? null;
    const lens = directive.seat ?? plain.lens;
    const modelSource = directive.modelSource ?? 'routing-policy';
    const head12 = String(directive.head ?? '').slice(0, 12);
    let actualModel = model;
    let fallbackFrom;
    const makeRow = (run, usedModel, extra = {}) => {
      const agyAnswer = run.status === 'ok' ? run.value : null;
      const comparison = compareShadowAnswers({ claude: claude.value, agy: agyAnswer, prTable: directive.identityTable ?? [] });
      return buildShadowRow({
        at: new Date(now()).toISOString(), repo: directive.repo, pr: directive.pr, head: directive.head,
        lens, runId: plain.runId, model: usedModel, requestedModel: model, modelSource,
        agyRun: { ...run, claudeSessionId }, agyAnswer, claudeAnswer: claude.value, comparison, ...extra,
      });
    };
    if (agyRun.status === 'failed' && typeof directive.fallbackModel === 'string'
      && directive.fallbackModel.trim() && directive.fallbackModel !== model) {
      appendRow(makeRow(agyRun, model, { fellBackTo: directive.fallbackModel }));
      fallbackFrom = { model, status: agyRun.status, reasons: agyRun.reasons ?? [] };
      const reason = String(fallbackFrom.reasons[0] ?? 'no reason given').slice(0, 200);
      logReviewSeat(log, `review-seat: agy shadow ${lens} on PR ${directive.repo}#${directive.pr} head ${head12}: ${model} ${agyRun.status} (${reason}) — FALLING BACK to ${directive.fallbackModel}`);
      actualModel = directive.fallbackModel;
      agyRun = await runAgy(actualModel);
    }
    // Reviewer independence: the shadow juror must be a different actor from the Claude juror on this seat.
    if (agyRun.status === 'ok' && (!agyRun.sessionId || agyRun.sessionId === claudeSessionId)) {
      agyRun = { ...agyRun, status: 'voided', reasons: ['agy juror reported no session id distinct from the Claude juror'] };
    }
    const row = makeRow(agyRun, actualModel, fallbackFrom ? { fallbackFrom } : {});
    const { claudeVerdict, agyVerdict, verdictAgree, overlap, agyMatched } = row;
    const comparison = { claudeVerdict, agyVerdict, verdictAgree, overlap, agyMatched };
    const recorded = appendRow(row);
    logReviewSeat(log, `review-seat: agy shadow verdict PR ${directive.repo}#${directive.pr} head ${head12} seat ${lens} model ${actualModel} status ${agyRun.status} verdict ${agyVerdict ?? 'none'} findings ${row.agyFindingsCount ?? 'none'} (claude ${claudeVerdict}, agree ${verdictAgree ?? 'n/a'})`);
    const shadow = {
      provider: 'agy', model: actualModel, requestedModel: model, modelSource,
      ...(fallbackFrom ? { fallbackFrom } : {}),
      status: agyRun.status, reasons: agyRun.reasons ?? [], sessionId: agyRun.sessionId ?? null,
      ...comparison,
      ...(agyRun.status === 'ok' ? { summary: String(agyRun.value?.summary ?? ''), findings: agyRun.value?.findings ?? [] } : {}),
      recorded,
    };
    return wrap({ ...claude.value, seatProvider: { provider: 'claude', shadow: 'agy' }, shadow }, claude.telemetry);
  }

  // mode === 'agy'
  const agyRun = await runAgy();
  if (agyRun.status === 'ok' && agyRun.sessionId) {
    const t = agyRun.telemetry ?? {};
    return wrap(
      { ...agyRun.value, seatProvider: { provider: 'agy', model, sessionId: agyRun.sessionId } },
      { sessionId: agyRun.sessionId, wallMs: agyRun.wallMs, durationMs: agyRun.wallMs, costUsd: 0, usage: t.usage,
        numTurns: t.numTurns, stopReason: t.stopReason, transcriptFile: agyRun.transcriptFile, model: agyRun.servedModel ?? model },
    );
  }
  const why = agyRun.status === 'ok' ? ['agy juror reported no session id'] : (agyRun.reasons ?? []);
  const fellBack = { provider: 'agy', model, status: agyRun.status === 'ok' ? 'voided' : agyRun.status, reasons: why };
  if (directive.onEscape === 'skip') {
    const reason = `agy seat ${fellBack.status}: ${why.join('; ') || 'no reason given'}`.slice(0, 600);
    return wrap({ summary: `skipped: ${reason}`, findings: [], skipped: { provider: 'agy', reason }, seatProvider: fellBack });
  }
  const claude = unwrap(await claudeJudge(plain));
  return wrap({ ...claude.value, seatProvider: { provider: 'claude', fellBackFrom: fellBack } }, claude.telemetry);
}
