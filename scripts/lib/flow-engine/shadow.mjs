import { readFileSync, statSync } from 'node:fs';
import { load, plan, transitionRecord, appendTransition, canonicalJSON } from './index.mjs';

export function comparePlans(left, right) {
  const equal = canonicalJSON(left) === canonicalJSON(right);
  return { equal, blocksRetirement: !equal, finding: equal ? null : 'FlowEngine/v0 plan disagreement' };
}

// Explicit opt-in file contains {definition, projection, ctx, logPath}. It is prepared by
// the operator from independent review-loop evidence, never inferred from the actual result.
export async function shadowReviewStep({ repo, pr, classified }, {
  file = process.env.WE_FLOW_V0_SHADOW_FILE, read = readFileSync, stat = statSync,
  engine = { load, plan, transitionRecord, appendTransition }, log = message => console.error(message),
} = {}) {
  const note = message => { try { log(message.replace(/[\x00-\x1f\x7f]/g, ' ')); } catch { /* diagnostic only */ } };
  if (!file) return;
  try {
    note('flow-v0 shadow enabled; source=environment WE_FLOW_V0_SHADOW_FILE (or explicit caller option)');
    if (stat(file).size > 262144) throw Error('shadow input exceeds 256 KiB; operator must supply a bounded projection');
    const input = JSON.parse(read(file, 'utf8'));
    if (input.ctx.repo !== repo || String(input.ctx.pr) !== String(pr)) throw Error('shadow context does not match actual PR');
    const flow = engine.load(input.definition);
    if (input.ctx.seq !== input.projection.seq + 1) throw Error('shadow context does not match projection sequence');
    const steps = engine.plan(flow, input.projection);
    // Translate only observed legacy words; uncertain legacy outcomes stay unknown.
    const actual = classified.loopOutcome === 'converged' && classified.verdict === 'accept' ? 'accept'
      : classified.verdict === 'changes' && classified.outcome === 'bounced' ? 'continue' : 'unknown';
    for (const step of steps) {
      const record = engine.transitionRecord(flow, step, input.ctx);
      if (!await engine.appendTransition(input.logPath, record)) note('flow-v0 shadow append failed; operator must inspect review-loop log');
      note(`flow-v0 shadow ${canonicalJSON({ repo, pr, seq: input.ctx.seq, step, actual: classified, agreement: step.from === 'judge-convergence' && step.guard === 'convergence' && step.outcome === actual })}`);
      if (step.from !== 'judge-convergence' || step.guard !== 'convergence' || step.outcome !== actual) note('flow-v0 shadow disagreement; operator review required; no gate decision changed');
    }
  } catch (e) { note(`flow-v0 shadow failed; operator must inspect input: ${String(e?.message ?? e)}`); }
}
