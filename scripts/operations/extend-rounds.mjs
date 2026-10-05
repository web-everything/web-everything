/** Operator-only audited round grant. --preview plans without posting; IO lives in extend-rounds-io.mjs. */
import { op } from './registry.mjs';
import { compute, effect as effectStep } from './step-kinds.mjs';
import { OPERATOR_LOGINS } from '../lib/marker-authorship.mjs';
import { buildRoundExtensionComment } from '../conveyor/round-extension-mark.mjs';

export const EXTEND_ROUNDS_OP = 'extend-rounds';
export const ROUND_EXTENSION_POST_EFFECT = 'github.round-extension';

/** Pure verdict: attribution is the operator's, with verbatim reason and an explicit channel. */
export function planRoundExtension(read, input) {
  const { repo, pr, by, actor, channel, reason } = input;
  if (!OPERATOR_LOGINS.includes(String(actor ?? '').toLowerCase())) {
    throw new Error(`--actor must be a registered operator login (${OPERATOR_LOGINS.join(', ')}); this extension is the operator's`);
  }
  if (!String(reason ?? '').trim()) throw new Error("--reason is required: the operator's words, verbatim");
  if (!String(channel ?? '').trim() || /[\r\n]/.test(channel)) throw new Error('--channel is required and must be one line');
  if (!Number.isInteger(by) || by < 1 || by > 5) throw new Error('--by must be an integer in 1..5');
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo ?? '')) throw new Error('--repo must be <owner/repo>');
  if (!Number.isSafeInteger(pr) || pr <= 0) throw new Error('--pr must be a positive integer');
  if (read.state !== 'OPEN') throw new Error('the PR must be open to extend its rounds');
  const record = { version: 1, repo, pr, by, actor: String(actor).toLowerCase(),
    channel: String(channel).trim(), reason: String(reason), at: read.now };
  return { record, body: buildRoundExtensionComment(record) };
}

export function extendRoundsOperation({ readExtensionContext } = {}) {
  if (typeof readExtensionContext !== 'function') throw new TypeError('extend-rounds: needs a readExtensionContext reader');
  return op(EXTEND_ROUNDS_OP, {
    input: {
      repo: 'string', pr: 'number', by: 'number', actor: 'string', channel: 'string', reason: 'string',
      preview: { type: 'boolean', required: false, default: false },
    },
    verdictFrom: 'plan',
    read: compute({
      reads: ['input.repo', 'input.pr'],
      fn: (view) => readExtensionContext({ repo: view.input.repo, pr: view.input.pr }),
    }),
    plan: compute({
      reads: ['findings.read', 'input.repo', 'input.pr', 'input.by', 'input.actor', 'input.channel', 'input.reason'],
      fn: (view) => planRoundExtension(view.findings.read, view.input),
    }),
    write: effectStep({
      reads: ['verdict', 'input.preview'],
      effects: (view) => view.input.preview ? [] : [{
        type: ROUND_EXTENSION_POST_EFFECT, idempotent: false, payload: view.verdict,
      }],
    }),
  });
}
