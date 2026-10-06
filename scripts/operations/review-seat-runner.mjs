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
 *                 reduced into the verdict) and appended as one row to the agreement store
 *                 (`we:scripts/lib/review-shadow-agreement.mjs`). An agy failure or escape never touches the Claude
 *                 answer.
 *   - `agy`     — the agy juror runs. Its answer becomes the seat's answer only when it finished, answered, and none of
 *                 the escape checks fired. Otherwise the seat FALLS BACK to Claude (`onEscape: 'claude'`), or — for an
 *                 advisory seat (`onEscape: 'skip'`) — is recorded as skipped, so an advisory seat never spends Claude.
 *
 * The two jurors run one after the other, never together: the escape check snapshots the review lane around the agy
 * run, and a Claude juror's own mutation probes in that same lane would read as an agy escape.
 *
 * Every answer this returns carries `seatProvider: {provider, ...}` so the run record says who actually judged.
 */
import { runAgyReviewJuror } from '../lib/agy-review-juror.mjs';
import { appendShadowRow, buildShadowRow, compareShadowAnswers } from '../lib/review-shadow-agreement.mjs';

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
 * @param {() => number} [io.now]
 */
export async function runSeatWithProvider(request, {
  claudeJudge, unwrap, wrap, cwd, agyJuror = runAgyReviewJuror, appendRow = appendShadowRow, now = () => Date.now(),
}) {
  const { seatProvider: directive, ...plain } = request;
  if (!directive || !SEAT_RUN_MODES.includes(directive.mode)) {
    throw new Error(`review-seat-runner: unknown seat provider mode ${JSON.stringify(directive?.mode)} — one of ${SEAT_RUN_MODES.join('|')}`);
  }
  const model = directive.model;
  const runAgy = () => agyJuror({ request: plain, laneCwd: cwd, model });

  if (directive.mode === 'shadow') {
    const claude = unwrap(await claudeJudge(plain));
    let agyRun;
    try { agyRun = await runAgy(); } catch (e) { agyRun = { status: 'failed', reasons: [String(e?.message ?? e)] }; }
    const claudeSessionId = claude.telemetry?.sessionId ?? null;
    // Reviewer independence: the shadow juror must be a different actor from the Claude juror on this seat.
    if (agyRun.status === 'ok' && (!agyRun.sessionId || agyRun.sessionId === claudeSessionId)) {
      agyRun = { ...agyRun, status: 'voided', reasons: ['agy juror reported no session id distinct from the Claude juror'] };
    }
    const comparison = compareShadowAnswers({
      claude: claude.value, agy: agyRun.status === 'ok' ? agyRun.value : null, prTable: directive.identityTable ?? [],
    });
    const row = buildShadowRow({
      at: new Date(now()).toISOString(), repo: directive.repo, pr: directive.pr, head: directive.head,
      lens: directive.seat ?? plain.lens, runId: plain.runId, model,
      agyRun: { ...agyRun, claudeSessionId }, comparison,
    });
    const recorded = appendRow(row);
    const shadow = {
      provider: 'agy', model, status: agyRun.status, reasons: agyRun.reasons ?? [], sessionId: agyRun.sessionId ?? null,
      ...comparison,
      ...(agyRun.status === 'ok' ? { summary: String(agyRun.value?.summary ?? ''), findings: agyRun.value?.findings ?? [] } : {}),
      recorded,
    };
    return wrap({ ...claude.value, seatProvider: { provider: 'claude', shadow: 'agy' }, shadow }, claude.telemetry);
  }

  // mode === 'agy'
  let agyRun;
  try { agyRun = await runAgy(); } catch (e) { agyRun = { status: 'failed', reasons: [String(e?.message ?? e)] }; }
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
