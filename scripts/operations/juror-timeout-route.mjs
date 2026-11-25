import { redactSpawnText } from '../lib/describe-spawn-failure.mjs';
import { retryCounterValid } from './run-record.mjs';

const clean = (value, max = 80) => redactSpawnText(String(value ?? '?')).replace(/[\x00-\x1f\x7f-\x9f\p{Zl}\p{Zp}]/gu, ' ').slice(0, max);
// Only the saved seat's routes may be retried; unknown families never grant independence.
const family = value => /^(claude|agy-claude|sonnet|opus|haiku)/.test(value ?? '') ? 'claude'
  : /^(codex|gpt-)/.test(value ?? '') ? 'codex' : /^(gemini|agy-gemini|antigravity)/.test(value ?? '') ? 'gemini' : null;
export function nextJurorRoute({ lens, tried = [], directive, builder }) {
  if (!directive || !Number.isFinite(directive.timeoutMs) || directive.timeoutMs <= 0) return null;
  const primary = family(directive.model) ?? family(directive.providerName);
  if (!primary) return null;
  const author = family(typeof builder === 'string' ? builder : builder?.model);
  for (const model of [directive.model, directive.fallbackModel]) {
    const vendor = family(model);
    if (!model || !vendor || tried.some(r => (typeof r === 'string' ? r : r.model) === model)) continue;
    if (vendor !== primary && (!['correctness', 'security'].includes(lens) || !author || author === vendor)) continue;
    return { model, provider: vendor === 'gemini' ? 'antigravity' : vendor,
      timeoutMs: Math.min(60 * 60_000, directive.timeoutMs * 1.5) };
  }
  return null;
}

export function jurorTimeoutEvidence(run, builder) {
  if (run?.pending?.kind !== 'judge'
    || (!Object.hasOwn(run, 'seatTimeouts') && !Object.hasOwn(run, 'jurorResumeAttempts'))) return null;
  const request = run.pending.request;
  const head = run?.findings?.read?.netBasis?.rev;
  const history = Array.isArray(run.seatTimeouts) ? run.seatTimeouts : [];
  const tried = history.filter(s => s && s.head === head && s.lens === request?.lens && s.step === run.pending.step);
  // A persisted retry marker without matching seat evidence cannot prove a fresh retry budget.
  const complete = request && head && tried.length > 0 && history.every(s => s && typeof s === 'object');
  return { lens: request?.lens, tried, builder, step: run.pending.step,
    attempts: !complete ? 3 : run.jurorResumeAttempts === undefined ? 0 : retryCounterValid(run.jurorResumeAttempts, 3) ? run.jurorResumeAttempts : 3,
    directive: complete ? { model: request.model, providerName: request.providerName,
      fallbackModel: request.seatProvider?.fallbackModel, timeoutMs: tried.at(-1).timeoutMs } : null };
}

export function jurorTimeoutHold(run, capacity = () => null) {
  const seat = run?.jurorTimeout;
  if (!seat) return null;
  const next = nextJurorRoute(seat);
  const blocked = next && capacity(next.provider);
  if (retryCounterValid(seat.attempts, 3) && seat.attempts < 3 && seat.tried.length < 2 && next && !blocked) return null;
  const routes = seat.tried.slice(0, 2).map(s => `${clean(s.provider)}/${clean(s.model).replace(/^claude-opus.*$/, 'opus')} ${clean(s.timeoutMs / 60_000, 12)}m`).join(', ');
  return { kind: 'juror-timeout', head: clean(run.head, 40), episode: `juror-timeout:${clean(run.id)}:${clean(seat.lens)}`,
    why: `review-blocked-on-infra: juror timeout x${clean(seat.tried.length, 12)} (${clean(seat.lens)}: ${routes}; head ${clean(run.head, 12)})`
      + `; ${clean(blocked || (next ? 'retry budget spent' : 'no allowed route remains'))}\nOrchestrator: inspect the timed-out seat and provider capacity before re-arming this head.` };
}
