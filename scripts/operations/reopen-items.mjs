/** Reopen retired work without clearing it for the conveyor. Pure declaration. */
import { applyTransition } from '../backlog/frontmatter.mjs';
import { batchOperation, cardIndex, splitIds } from './close-items.mjs';
export const REOPEN_ITEMS_OP = 'reopen-items';
export const REOPEN_ITEMS_EFFECT = 'reopen-items.write';
export function planReopenItems(read, input) {
  if (!input.reason?.trim() || !splitIds(input.ids).length) throw Object.assign(new Error('ids and a non-empty reason are required'), { reason: 'invalid-input' });
  const index = cardIndex(read.cards), refused = [], reopened = [], writes = [];
  const ids = splitIds(input.ids);
  for (const id of ids) {
    const c = index.get(id);
    if (!c || c.status !== 'closed') { refused.push({ id, refusal: c ? 'not-closed' : 'not-found', detail: 'Only a closed card can reopen' }); continue; }
    const res = applyTransition(c.content, 'reopen', { today: read.today, reason: input.reason });
    if (res.error) { refused.push({ id, refusal: 'transition-refused', detail: res.error }); continue; }
    reopened.push({ id, file: c.file }); writes.push({ abs: c.abs, rel: c.file, content: res.content });
  }
  const byRefusal = {};
  for (const r of refused) byRefusal[r.refusal] = (byRefusal[r.refusal] ?? 0) + 1;
  return { output: { dryRun: !input.apply, reason: input.reason,
    counts: { requested: ids.length, [input.apply ? 'reopened' : 'wouldReopen']: writes.length, refused: refused.length, byRefusal },
    reopened, refused, note: 'Reopening does not re-add items to the build queue. Re-clearing is an operator act.' }, writes,
    audit: { actor: read.actor, channel: read.channel, reason: input.reason, ids } };
}
export function reopenItemsOperation({ readReopenItemsContext } = {}) {
  return batchOperation(REOPEN_ITEMS_OP, REOPEN_ITEMS_EFFECT, readReopenItemsContext, planReopenItems, { ids: 'string', reason: 'string' });
}
