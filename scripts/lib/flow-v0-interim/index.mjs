import { appendFile } from 'node:fs/promises';
import { assertFlow } from './load.mjs';
export { load, version, canonicalJSON } from './load.mjs';
export { plan } from './plan.mjs';
export const predicateType = 'https://github.com/web-everything/web-everything/blob/main/schemas/flow-v0-interim/v0.1/transition';
export function transitionRecord(flow, step, ctx) {
  assertFlow(flow);
  if (!/^[a-f0-9]{40}$/.test(ctx.head) || !/^[a-f0-9]{64}$/.test(ctx.netDiff) || !/^[a-f0-9]{40}$/.test(ctx.executorCommit) || !Number.isSafeInteger(ctx.seq) || ctx.seq < 1 || !Number.isFinite(Date.parse(ctx.at)) || !Array.isArray(ctx.inputs)) throw Error('Incomplete transition context');
  const subject = `${ctx.repo}#${ctx.pr}`;
  return { _type: 'https://in-toto.io/Statement/v1', subject: [
    { name: subject, uri: `https://github.com/${ctx.repo}/pull/${ctx.pr}`, digest: { gitCommit: ctx.head },
      annotations: { 'we.id': `tag:everstandards.dev,${ctx.at.slice(0, 10)}:flow-run/we/${ctx.repo}/${ctx.pr}/t${ctx.seq}`, 'we.idempotencyKey': `tr:${subject}:${ctx.seq}` } },
    { name: 'net-diff', digest: { sha256: ctx.netDiff } },
  ], predicateType, predicate: { ...step, flow: flow.definition.id, flowDigest: { sha256: flow.digest }, seq: ctx.seq,
    ...(flow.definition.states[step.from]?.kind === 'confirm' ? { subjectVersion: ctx.head } : {}),
    inputs: [...ctx.inputs], at: ctx.at, executor: `https://github.com/web-everything/web-everything/blob/${ctx.executorCommit}/scripts/lib/flow-v0-interim/plan.mjs` } };
}
export async function appendTransition(path, record, append = appendFile) {
  try { await append(path, `${JSON.stringify(record)}\n`, { flag: 'a' }); return true; } catch { return false; }
}
