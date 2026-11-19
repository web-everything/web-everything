/** Advise-only preparation, declared once; flags are derived by cli-adapter. */
import { op } from './registry.mjs';
import { compute, effect } from './step-kinds.mjs';
import { buildRecord, classify, recordHash, validate } from '../lib/prep-record.mjs';
export const PREP_OP = 'prep';
export const PREP_STORE_EFFECT = 'prep.store';

export function assessPrep(input, context) {
  const { config, record: original, errors = [], provenance = {} } = context;
  if (!['new', 'check', 'amend'].includes(input.action)) return { advice: ['action must be new, check or amend'], write: false };
  if (!original) return { advice: errors, write: false };
  let record = original;
  if (input.action === 'amend') {
    const updates = Object.fromEntries(['acceptance', 'preMortem', 'testPlan', 'baseSha', 'source', 'threatModel']
      .filter(k => input[k]).map(k => [k, input[k]]));
    if (typeof input.untrustedOutput === 'boolean') updates.untrustedOutput = input.untrustedOutput;
    const { history: _history, ...snapshot } = original;
    record = buildRecord({ ...original, ...updates,
      touchSet: [...(original.touchSet ?? []), ...(input.touchSet || '').split(',').filter(Boolean)],
      history: [...(original.history ?? []), { hash: recordHash(original), record: snapshot }],
    });
  }
  const validity = validate(record);
  return { record, ...validity, ...classify(record, config), hash: recordHash(record), provenance,
    advice: [...errors, ...validity.missing.map(k => `Missing or placeholder: ${k}`), ...validity.errors],
    write: input.action !== 'check' && !errors.length };
}

export function prepOperation({ readContext } = {}) {
  if (typeof readContext !== 'function') throw new TypeError('prep needs readContext');
  const optional = { type: 'string', required: false, default: '' };
  const input = Object.fromEntries(['id', 'card', 'brief', 'pr', 'acceptance', 'preMortem', 'testPlan', 'touchSet', 'baseSha', 'source', 'threatModel'].map(k => [k, optional]));
  return op(PREP_OP, {
    input: { action: 'string', ...input, untrustedOutput: { type: 'boolean', required: false } }, verdictFrom: 'assess',
    read: compute({ reads: ['input'], fn: ({ input }) => readContext(input) }),
    assess: compute({ reads: ['input', 'findings.read'], fn: ({ input, findings }) => assessPrep(input, findings.read) }),
    store: effect({ reads: ['verdict', 'input.action'], effects: ({ verdict, input }) => verdict.write
      ? [{ type: PREP_STORE_EFFECT, payload: { record: verdict.record, action: input.action }, idempotent: true }] : [] }),
  });
}
export function finishPrep({ run, lines, json }) {
  const result = run?.verdict;
  return { code: 0, lines: json ? lines : [JSON.stringify(result ?? { advice: ['Preparation unavailable; inspect inputs and retry.'] })] };
}
