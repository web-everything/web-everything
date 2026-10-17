/** Batch coordinator. Only single-card runs receive a worker brief; assembly never launches a model. */
import { parseGroupMembers } from './dispatch-lane.mjs';

export async function runPrepareBatch(args, io, policy, runCard) {
  const ids = [String(args.num), ...parseGroupMembers(args.groupMembers).filter(n => n !== String(args.num))];
  const parallel = policy.batchParallel ?? true;
  const limit = Math.min(policy.batchMaxParallel ?? 3, io.batchExternalCap ?? 4);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('prepare batch requires positive external concurrency');
  for (const [key, value] of [['batchParallel', parallel], ['batchMaxParallel', policy.batchMaxParallel ?? 3]]) {
    io.log(`prepare.${key}=${value} (from ${policy.sources?.[key] ?? 'standard'})`);
  }
  io.log(`prepare batch worker limit=${parallel ? limit : 1} (builder external cap=${io.batchExternalCap ?? 4})`);
  const results = new Array(ids.length);
  let cursor = 0;
  const consume = async () => {
    while (cursor < ids.length) {
      const index = cursor++, num = ids[index];
      try {
        // Resolve only this card's lease scope. Never forward the grouped dispatch scope or another body.
        const card = io.findItem(num);
        if (!card) throw new Error('card not found');
        const scope = [`we:${card.path}`];
        if (args.scope?.length && !args.scope.includes(`we:${card.path}`) && !args.scope.includes(card.path)) {
          throw new Error('card outside dispatch lease scope');
        }
        const session = `${args.session}-card-${num}`;
        const cardIo = io.forPrepareCard?.({ session }) ?? io;
        const result = await runCard({ ...args, num, groupMembers: [], scope,
          lane: undefined, session, runId: undefined, effectKey: undefined,
          prepareCommitOnly: true }, { ...cardIo, preparePolicy: policy, settlePrepare: () => {} });
        if (result.outcome === 'prepared-commit') {
          // Per-card refs are local retention refs, never publication requests.
          io.retainPrepareCommit(result.lanePath, `lane/prep-${num}`, result.sha);
        }
        results[index] = { ...result, session };
      } catch {
        results[index] = { outcome: 'deferred', detail: 'card preparation failed' };
      }
    }
  };
  await Promise.all(Array.from({ length: parallel ? Math.min(limit, ids.length) : 1 }, consume));
  const groupDropped = [], groupDropReasons = {}, conflicts = [];
  const drop = (num, reason) => { groupDropped.push(num); groupDropReasons[num] = reason; };
  const prepared = results.flatMap((r, i) => {
    if (r.outcome === 'prepared-commit') return [r];
    drop(ids[i], r.detail ?? r.outcome);
    return [];
  });
  const settle = result => {
    // A failed assembly/publication delivered none of the surviving commits. Account for each
    // unsuccessful card; only an actual cherry-pick conflict gets a budget-free next batch.
    if (result.outcome !== 'opened-pr') for (const num of ids) {
      if (!conflicts.includes(num) && !groupDropped.includes(num)) drop(num, result.detail ?? result.outcome);
    }
    result = { executor: args.worker?.executor ?? 'none', ...result, groupMembers: ids.slice(1), groupDropped, groupDropReasons,
      deferredToNextBatch: [...conflicts] };
    try {
      io.settlePrepare?.({ runId: args.runId, key: args.effectKey,
        status: result.outcome === 'opened-pr' ? 'applied' : 'failed', result });
    } catch { io.log('prepare batch settlement failed'); }
    return result;
  };
  try {
    if (!prepared.length) return settle({ outcome: 'gate-red', detail: 'no cards passed prepare checks' });
    const lanePath = prepared[0].lanePath;
    const assemblyIo = io.forPrepareCard?.({ session: prepared[0].session }) ?? io;
    // Reset only the assembler's own acquired lane. Retention refs protect every original commit.
    assemblyIo.startPrepareAssembly(lanePath, prepared[0].baseSha);
    const assembled = [];
    for (const card of prepared) {
      const picked = assemblyIo.cherryPickPrepare(lanePath, card);
      if (!picked.ok) {
        if (!picked.conflict) throw new Error('prepare assembly failed');
        drop(card.num, 'cherry-pick conflict; deferred to next batch');
        conflicts.push(card.num);
        continue;
      }
      assembled.push(card);
    }
    if (!assembled.length) return settle({ outcome: 'gate-red', detail: 'all cards deferred to next batch' });
    const preparedIds = assembled.map(c => c.num);
    const finalRef = `lane/prepare-batch-${ids[0]}-${preparedIds.length}`;
    assemblyIo.finishPrepareAssembly(lanePath, finalRef);
    const gate = assemblyIo.runGate(lanePath);
    if (!gate.pass) return settle({ outcome: 'gate-red', detail: 'assembled prepare gate failed' });
    const diff = { files: assembled.length, loc: assembled.reduce((n, c) => n + (c.diff?.loc ?? 0), 0) };
    const bodyFile = assemblyIo.writePrBody(lanePath, { ...args, diff, groupMembers: ids.slice(1), groupDropped,
      groupDropReasons, proposedEdges: assembled.flatMap(c => c.proposedEdges ?? []) });
    const submitted = assemblyIo.openPr({ lanePath, num: ids[0], slug: 'batch', bodyFile,
      taskType: 'prepare', preparedIds });
    return settle({ outcome: submitted.ok ? 'opened-pr' : 'escalated-needs-human', pr: submitted.pr ?? null,
      detail: submitted.ok ? `assembled ${assembled.length} card commits in one PR` : 'assembled PR publication failed' });
  } catch {
    return settle({ outcome: 'escalated-needs-human', detail: 'prepare assembly failed; retained card commits require inspection' });
  }
}
