/**
 * @file scripts/operations/related-items.mjs
 * @description THE `related-items` DECLARATION — read-only: "which backlog cards is this idea already about?",
 *   run before proposing or filing anything (operator 2026-10-21; the live miss was card 5743, see
 *   `we:scripts/lib/related-items-core.mjs`). Ranks open / parked / active cards (and recently resolved ones) by
 *   wording (IDF-weighted, with a synonym table), scope overlap and shared tags, and says why each one matched.
 *
 *   node scripts/operations/run.mjs related-items --text="shared node_modules across lanes" [--scope=we:a,we:b]
 *     [--tags=x,y] [--limit=N] [--json]
 *
 * One `compute` step, no sinks. The card/settings read is INJECTED (`./related-items-io.mjs`), so this module imports
 * only the registry, the step kinds and the pure core.
 */
import { op } from './registry.mjs';
import { compute } from './step-kinds.mjs';
import { rankRelatedItems, renderRelatedItems, formatRelatedItemsPolicy } from '../lib/related-items-core.mjs';

export const RELATED_ITEMS_OP = 'related-items';

/** PURE. The verdict for one query over an already-read context. */
export function assessRelatedItems(ctx, input) {
  const policy = ctx.policy;
  const policyLine = formatRelatedItemsPolicy(policy);
  if (!policy.enabled) return { disabled: true, policy: policyLine, matches: [], eligible: 0, aboveThreshold: 0, threshold: policy.threshold };
  if (!String(input.text ?? '').trim()) throw new Error('related-items: give --text="<title and idea>"');
  const result = rankRelatedItems({
    query: { text: input.text, scope: input.scope, tags: input.tags, limit: input.limit, exclude: input.exclude },
    cards: ctx.cards, policy, today: ctx.today,
  });
  return { ...result, unreadable: ctx.unreadable ?? 0, policy: policyLine };
}

export function relatedItemsOperation({ readContext } = {}) {
  if (typeof readContext !== 'function') {
    throw new TypeError('related-items: needs a `readContext()` reader — the real binding is `we:scripts/operations/related-items-io.mjs`.');
  }
  return op(RELATED_ITEMS_OP, {
    input: {
      text: 'string',
      scope: { type: 'string', required: false, default: '' },
      tags: { type: 'string', required: false, default: '' },
      limit: { type: 'number', required: false, default: 0 },
      exclude: { type: 'string', required: false, default: '' },
    },
    verdictFrom: 'rank',
    rank: compute({
      reads: ['input.text', 'input.scope', 'input.tags', 'input.limit', 'input.exclude'],
      fn: ({ input }) => assessRelatedItems(readContext(), input),
    }),
  });
}

/** The human trailer (`--json` prints the run payload unchanged). */
export function finishRelatedItems({ run, code, lines, json = false }) {
  if (json || !run?.verdict) return { code, lines };
  return { code, lines: renderRelatedItems(run.verdict, { policyLine: run.verdict.policy }) };
}
