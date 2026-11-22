import { openSync, readSync, closeSync } from 'node:fs';

const LIMIT = 262144;
function readBounded(file, { open, read, close }) {
  const fd = open(file, 'r');
  try {
    const buffer = Buffer.alloc(LIMIT + 1);
    let size = 0;
    while (size < buffer.length) {
      const n = read(fd, buffer, size, buffer.length - size, null);
      if (!n) break;
      size += n;
    }
    if (size > LIMIT) throw Error('shadow input exceeds 256 KiB; operator must supply a bounded projection');
    return buffer.toString('utf8', 0, size);
  } finally { close(fd); }
}
import { load, plan, transitionRecord, appendTransition, canonicalJSON } from './index.mjs';

export function comparePlans(left, right) {
  const equal = canonicalJSON(left) === canonicalJSON(right);
  return { equal, blocksRetirement: !equal, finding: equal ? null : 'FlowEngine/v0 plan disagreement' };
}

// Explicit opt-in file contains {definition, projection, ctx, logPath}. It is prepared by
// the operator from independent review-loop evidence, never inferred from the actual result.
export async function shadowReviewStep({ repo, pr, classified, head, netDiff, round, runId }, {
  file = process.env.WE_FLOW_V0_SHADOW_FILE, open = openSync, read = readSync, close = closeSync,
  engine = { load, plan, transitionRecord, appendTransition }, log = message => console.error(message),
} = {}) {
  const note = message => { try { log(message.replace(/[\x00-\x1f\x7f]/g, ' ')); } catch { /* diagnostic only */ } };
  if (!file) return;
  try {
    note('flow-v0 shadow enabled; source=environment WE_FLOW_V0_SHADOW_FILE (or explicit caller option)');
    const input = JSON.parse(readBounded(file, { open, read, close }));
    if (input.ctx.repo !== repo || String(input.ctx.pr) !== String(pr)) throw Error('shadow context does not match actual PR');
    for (const [name, value] of Object.entries({ head: head ?? classified?.head, netDiff: netDiff ?? classified?.netDiff, round: round ?? classified?.round, runId: runId ?? classified?.runId })) {
      if (value != null && input.ctx[name] !== value) throw Error(`shadow context does not match actual ${name}`);
    }
    const flow = engine.load(input.definition);
    if (input.ctx.seq !== input.projection.seq + 1) throw Error('shadow context does not match projection sequence');
    const steps = engine.plan(flow, input.projection);
    // Only observed production completion fields can establish an actual transition.
    const outcome = classified?.outcome === 'auto-cleared' && classified.loopOutcome === 'converged' ? 'accept'
      : classified?.outcome === 'bounced' ? 'continue' : null;
    const actual = outcome ? { from: 'judge-convergence', guard: 'convergence', outcome,
      route: 'advance', to: outcome === 'accept' ? 'accepted' : 'judge-convergence' } : null;
    const agreement = steps.length === 1 && actual !== null && Object.entries(actual).every(([k, v]) => steps[0][k] === v);
    note(`flow-v0 shadow ${canonicalJSON({ repo, pr, seq: input.ctx.seq, steps, actual: classified, agreement })}`);
    if (!agreement) note('flow-v0 shadow disagreement; operator review required; no gate decision changed');
    for (const step of steps) {
      const record = engine.transitionRecord(flow, step, input.ctx);
      if (!await engine.appendTransition(input.logPath, record)) note('flow-v0 shadow append failed; operator must inspect review-loop log');
    }
  } catch (e) { note(`flow-v0 shadow failed; operator must inspect input: ${String(e?.message ?? e)}`); }
}
