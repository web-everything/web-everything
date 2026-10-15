/** Optional operator-card metadata; shared by filing and the standards gate. Pure. */
import { OPERATOR_LOGINS } from '../lib/marker-authorship.mjs';

export const EDGE_CLONE_NAMES = Object.freeze(['review', 'fix', 'control', 'drain', 'health-watch']);
// Same shape as dispatch-lane BRIEF_TOKEN_RE: the composed brief is filled again, which would rewrite or refuse it.
export const BRIEF_TOKEN_SHAPE = /\{\{\s*[^{}\n]*?\s*\}\}/;
// `preparedBy` value written by an operator filing stamp; a real prepare-stamp removes it.
export const OPERATOR_FILING_STAMP = 'operator-filing';

const oneLine = (value, max) => typeof value === 'string' && Boolean(value.trim()) && value.length <= max && !/[\r\n\p{Zl}\p{Zp}]/u.test(value);

/**
 * The attributed operator instruction behind an operator task, the same pattern as the clear-human ceremony:
 * the actor must be a registered operator login (OPERATOR_LOGINS), with the channel the instruction came
 * through, when, and the operator's words. Like clear-human, the actor is a recorded assertion, not a
 * signature; the card still lands through a reviewed PR. Returns the shape errors (empty = valid). PURE.
 */
export function validateOperatorInstruction(record, { operators = OPERATOR_LOGINS } = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return ['operatorInstruction must be an object with actor, channel, at and words'];
  const errors = [];
  if (!oneLine(record.actor, 100) || !/^[\w-]+$/.test(record.actor) || !operators.includes(record.actor.toLowerCase())) {
    errors.push(`operatorInstruction.actor must be a registered operator login (${operators.join(', ')})`);
  }
  if (!oneLine(record.channel, 200)) errors.push('operatorInstruction.channel must be one nonempty line of at most 200 characters');
  if (!oneLine(record.at, 40) || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(record.at) || !Number.isFinite(Date.parse(record.at))) errors.push('operatorInstruction.at must be an ISO date or time');
  if (!oneLine(record.words, 1000)) errors.push('operatorInstruction.words must be one nonempty line of at most 1000 characters');
  return errors;
}

/** True only for a card that is an operator task AND carries a valid operator record. Every operator-task
 *  treatment (post-build steps, the filing prepare stamp, an explicit P0) reads this, never the bare flag. */
export function hasOperatorRecord(item, options) {
  return item?.operatorTask === true && validateOperatorInstruction(item.operatorInstruction, options).length === 0;
}

export function validateOperatorTask(item) {
  const errors = [];
  if (item.operatorTask !== undefined && typeof item.operatorTask !== 'boolean') errors.push('operatorTask must be a boolean');
  if (item.operatorInstruction !== undefined) {
    if (item.operatorTask !== true) errors.push('operatorInstruction requires operatorTask: true');
    errors.push(...validateOperatorInstruction(item.operatorInstruction));
  }
  if (item.preparedBy !== undefined && item.preparedBy !== OPERATOR_FILING_STAMP) errors.push(`preparedBy must be "${OPERATOR_FILING_STAMP}"`);
  // Post-build fields never take effect without the flag, so refuse them rather than ignore them silently.
  if (item.operatorTask !== true && (item.edgeClone !== undefined || item.liveProof !== undefined || item.report === true)) errors.push('edgeClone, liveProof and report require operatorTask: true');
  if (item.edgeClone !== undefined && !EDGE_CLONE_NAMES.includes(item.edgeClone)) errors.push('edgeClone must be a daemon name: ' + EDGE_CLONE_NAMES.join(', ') + '; paths are refused');
  if (item.report !== undefined && typeof item.report !== 'boolean') errors.push('report must be a boolean');
  if (item.liveProof !== undefined) {
    const p = item.liveProof;
    if (!p || typeof p !== 'object' || Array.isArray(p) || typeof p.command !== 'string' || !p.command.trim() || typeof p.expect !== 'string' || !p.expect.trim()) errors.push('liveProof requires nonempty command and expect strings');
    else if (BRIEF_TOKEN_SHAPE.test(p.command) || BRIEF_TOKEN_SHAPE.test(p.expect)) errors.push('liveProof must not contain {{...}} brief tokens');
    else if (p.expect.startsWith('/')) {
      const match = /^\/(.*)\/([imsu]*)$/s.exec(p.expect);
      try { if (!match) throw new Error(); new RegExp(match[1], match[2]); } catch { errors.push('liveProof.expect has an invalid /regex/flags'); }
    }
  }
  return errors;
}
export function operatorTaskFields(input, { at } = {}) {
  const fields = {};
  if (input.operatorTask === true) {
    fields.operatorTask = true;
    if (!input.operatorActor || !input.operatorChannel || !input.operatorWords) {
      throw new Error('operatorTask requires --operatorActor (a registered operator login), --operatorChannel and --operatorWords: the operator instruction it records');
    }
    fields.operatorInstruction = { actor: input.operatorActor, channel: input.operatorChannel, at, words: input.operatorWords };
  } else if (input.operatorActor || input.operatorChannel || input.operatorWords) {
    throw new Error('--operatorActor, --operatorChannel and --operatorWords require --operatorTask');
  }
  if (input.edgeClone) fields.edgeClone = input.edgeClone;
  if (input['liveProof-command'] || input['liveProof-expect']) fields.liveProof = { command: input['liveProof-command'], expect: input['liveProof-expect'] };
  if (input.report !== undefined && input.report !== '') {
    if (![true, false, 'true', 'false'].includes(input.report)) throw new Error('report must be a boolean');
    if (input.report === true || input.report === 'true') fields.report = true;
  }
  const errors = validateOperatorTask(fields);
  if (errors.length) throw new Error(errors.join('; '));
  return fields;
}
export const OPERATOR_TASK_INPUT = Object.freeze({
  operatorTask: { type: 'boolean', required: false, default: false },
  operatorActor: { type: 'string', required: false, default: '' },
  operatorChannel: { type: 'string', required: false, default: '' },
  operatorWords: { type: 'string', required: false, default: '' },
  edgeClone: { type: 'string', required: false, default: '' },
  'liveProof-command': { type: 'string', required: false, default: '' },
  'liveProof-expect': { type: 'string', required: false, default: '' },
  report: { type: 'boolean', required: false, default: false },
});
export const OPERATOR_TASK_READS = Object.keys(OPERATOR_TASK_INPUT).map(k => `input.${k}`);
