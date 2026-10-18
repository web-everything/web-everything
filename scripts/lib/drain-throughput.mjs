/** Drain scheduling only. Remember refusals, never positive merge authority. */
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { cascadePolicy, platformPreference, formatCascadeSourcesLine } from './policy-cascade.mjs';
import { readDeclaredSettings } from './settings-files.mjs';
import { writeJsonAtomic } from './atomic-json-file.mjs';

const defaults = { holdFirst: true, catchUpSkipUnchangedHolds: true, carryOverReadyFirst: true, catchUpSkipMaxMin: 15 };
export function resolveDrainThroughput({ env = process.env, file, platform, log = line => process.stderr.write(`${line}\n`) } = {}) {
  const pick = v => Object.fromEntries(Object.keys(defaults).filter(k => v?.[k] !== undefined).map(k => [k, v[k]]));
  const out = cascadePolicy('drain', pick((file ?? readDeclaredSettings().settings)?.drain), {
    standard: defaults, platform: pick(platform ?? platformPreference('drain', { env })), env,
    valid: Object.fromEntries(Object.keys(defaults).map(k => [k, k === 'catchUpSkipMaxMin' ? v => Number.isFinite(v) && v >= 0 : v => typeof v === 'boolean'])),
  });
  log(formatCascadeSourcesLine('drain', out));
  return out;
}
const key = c => `${c.repo ?? ''}#${c.num}`;
export function createHoldMemo(enabled) {
  const held = new Map();
  return async (c, evaluate) => {
    const id = `${key(c)}@${c.listedHeadSha || c.headSha || ''}`;
    if (enabled && held.has(id)) return held.get(id);
    const out = await evaluate(c);
    if (enabled && out) held.set(id, out);
    return out;
  };
}
export const HOLD_KINDS = new Set(['red-team-pending', 'overlap-yield', 'review-hold', 'numbering']);
export function holdSignature(pr, evidence) {
  if (!pr?.headRefOid || !Array.isArray(pr.labels)) return null;
  return createHash('sha256').update(JSON.stringify({ head: pr.headRefOid,
    labels: pr.labels.map(l => typeof l === 'string' ? l : l.name).sort(),
    updatedAt: pr.updatedAt, comments: pr.comments, reviews: pr.reviews, evidence })).digest('hex');
}
export function unchangedHold(previous, pr, evidence, { now = Date.now(), maxMin = 15 } = {}) {
  if (!Number.isFinite(previous?.recordedAt) || now < previous.recordedAt || now - previous.recordedAt >= maxMin * 60_000) return false;
  if (previous.kind === 'overlap-yield' && (!Number.isFinite(evidence?.overlap?.untilMs)
    || now >= evidence.overlap.untilMs || evidence.overlap.state !== 'OPEN' || !evidence.overlap.head)) return false;
  if (previous.kind === 'numbering' && evidence?.numberingOwed !== true) return false;
  const signature = holdSignature(pr, evidence);
  return !!signature && HOLD_KINDS.has(previous?.kind) && previous.signature === signature;
}
export function carryReady(rows) {
  return rows.filter(r => r.kind === 'ready-not-reached').slice(0, 100).map(r => ({ num: r.num, repo: r.repo ?? null }));
}
export function orderCarry(rows, carry, enabled = true) {
  if (!enabled) return rows;
  const keys = new Set(carry.map(key));
  return [...rows.filter(r => keys.has(key(r))), ...rows.filter(r => !keys.has(key(r)))];
}
export function readCarry(path) {
  try { const rows = JSON.parse(readFileSync(path, 'utf8')); return Array.isArray(rows) ? rows.filter(r => Number.isInteger(r?.num)).slice(0, 100) : []; }
  catch { return []; }
}
export function writeCarry(path, rows) {
  mkdirSync(dirname(path), { recursive: true });
  writeJsonAtomic(path, rows.slice(0, 100));
}
