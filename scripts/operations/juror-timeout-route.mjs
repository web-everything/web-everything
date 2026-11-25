// Only the saved seat's routes may be retried; unknown families never grant independence.
const family = value => /^(claude|agy-claude|sonnet|opus|haiku)/.test(value ?? '') ? 'claude'
  : /^(codex|gpt-)/.test(value ?? '') ? 'codex' : /^(gemini|agy-gemini|antigravity)/.test(value ?? '') ? 'gemini' : null;
export function nextJurorRoute({ lens, tried = [], directive, builder }) {
  if (!directive || !Number.isFinite(directive.timeoutMs) || directive.timeoutMs <= 0) return null;
  const primary = family(directive.model) ?? family(directive.providerName);
  if (!primary) return null;
  const author = family(builder?.provider ?? builder);
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
  const request = run?.pending?.kind === 'judge' && run.pending.request;
  const head = run?.findings?.read?.netBasis?.rev;
  const tried = (run?.seatTimeouts ?? []).filter(s => s.head === head && s.lens === request?.lens);
  if (!request || !tried.some(s => s.step === run.pending.step)) return null;
  return { lens: request.lens, tried, builder, step: run.pending.step,
    attempts: run.jurorResumeAttempts ?? 0,
    directive: { model: request.model, providerName: request.providerName,
      fallbackModel: request.seatProvider?.fallbackModel, timeoutMs: tried.at(-1).timeoutMs } };
}

export function jurorTimeoutHold(run, capacity = () => null) {
  const seat = run?.jurorTimeout;
  if (!seat) return null;
  const next = nextJurorRoute(seat);
  const blocked = next && capacity(next.provider);
  if (seat.tried.length < 2 && next && !blocked) return null;
  const routes = seat.tried.map(s => `${s.provider}/${s.model.replace(/^claude-opus.*$/, 'opus')} ${s.timeoutMs / 60_000}m`).join(', ');
  return { kind: 'juror-timeout', head: run.head, episode: `juror-timeout:${run.id}:${seat.lens}`,
    why: `review-blocked-on-infra: juror timeout x${seat.tried.length} (${seat.lens}: ${routes}; head ${run.head.slice(0, 12)})`
      + `; ${blocked || (next ? 'retry budget spent' : 'no allowed route remains')}\nOrchestrator: inspect the timed-out seat and provider capacity before re-arming this head.` };
}
