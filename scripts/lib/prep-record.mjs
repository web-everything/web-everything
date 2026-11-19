/** Pure record construction and advice. No authority is granted by a record or its hash. */
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import { nonTrivial } from './prep-block.mjs';
import { classifyPaths, matchesPath } from './touch-class.mjs';
import defaults from '../settings/prep-flow.json' with { type: 'json' };

const FIELDS = ['acceptance', 'preMortem', 'testPlan', 'touchSet', 'baseSha', 'source'];
const text = value => Array.isArray(value) ? value.join('\n') : typeof value === 'string' ? value : '';
export function buildRecord(input = {}) {
  const record = { kind: 'brief', mode: 'advise', ...input, touchSet: [...new Set(input.touchSet ?? [])] };
  record.hash = recordHash(record);
  return record;
}
export function validate(record = {}) {
  const missing = FIELDS.filter(key => !text(record[key]).split(/\r?\n/).some(nonTrivial));
  if (record.untrustedOutput && !text(record.threatModel).split(/\r?\n/).some(nonTrivial)) missing.push('threatModel');
  const errors = [];
  if (!Array.isArray(record.touchSet) || record.touchSet.some(p => typeof p !== 'string' || !p.trim())) errors.push('touchSet must be an array of nonempty paths or globs');
  return { ok: !missing.length && !errors.length, missing, errors };
}
export function classify(record, cfg = defaults) {
  const classes = classifyPaths(Array.isArray(record.touchSet) ? record.touchSet : [null], cfg);
  const reasons = classes.map(name => `sensitive class: ${name}`);
  const narrative = ['acceptance', 'preMortem', 'testPlan', 'threatModel', 'brief'].map(k => text(record[k])).join('\n');
  for (const trigger of cfg.threatModelTriggers ?? defaults.threatModelTriggers) {
    try { if (new RegExp(trigger, 'i').test(narrative)) reasons.push(`threat-model trigger: ${trigger}`); }
    catch { reasons.push('invalid threat-model trigger; restore settings or request design review'); }
  }
  if (record.untrustedOutput) reasons.push('untrusted output requires threat modeling');
  const fast = record.fastPath && Number.isInteger(record.fastPath.loc) && record.fastPath.loc >= 0
    && record.fastPath.loc <= (cfg.fastPath ?? defaults.fastPath).maxLoc
    && Array.isArray(record.touchSet) && record.touchSet.length > 0 && record.touchSet.length <= (cfg.fastPath ?? defaults.fastPath).maxFiles
    && !record.touchSet.some(p => /[*]/.test(p) || p.endsWith('/')) && !reasons.length;
  const designPassRequired = reasons.length > 0;
  return { classes, flow: designPassRequired ? 'opus-design' : fast ? 'fast' : 'standard', designPassRequired, reasons };
}
export function covers(touchSet, paths) {
  const uncovered = paths.filter(path => !touchSet.some(glob => matchesPath(path, glob)));
  return { covered: !uncovered.length, uncovered };
}
export function render(record) {
  const line = value => text(value).replace(/[\r\n\u2028\u2029]+/g, ' ');
  return `## PREP:\nPrep-Id: ${line(record.id)}\nAcceptance: ${line(record.acceptance)}\nPre-mortem: ${line(record.preMortem)}\nFiles: ${line(record.touchSet)}\nTests: ${line(record.testPlan)}\n`;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
  return value;
}
export function recordHash(record) {
  const { hash: _hash, ...content } = record;
  return createHash('sha256').update(JSON.stringify(canonical(content))).digest('hex');
}
/** cardPath is identity only; the IO shell supplies its text. */
export function recordFromCard({ text: body = '', cardPath, ...input }) {
  const front = body.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const data = front ? yaml.load(front[1]) ?? {} : {};
  const sections = {};
  let current;
  for (const line of body.slice(front?.[0].length ?? 0).split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      current = ({ acceptance: 'acceptance', 'pre-mortem': 'preMortem', risks: 'preMortem', tests: 'testPlan', 'test plan': 'testPlan' })[heading[1].toLowerCase()];
      if (current) sections[current] ??= [];
    } else if (current) sections[current].push(line);
  }
  return buildRecord({ ...Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, v.join('\n').trim()])),
    touchSet: (Array.isArray(data.scope) ? data.scope : []).map(p => String(p).replace(/^we:/, '')),
    source: cardPath ? `card:${cardPath}` : 'card text', kind: 'card', ...input });
}
