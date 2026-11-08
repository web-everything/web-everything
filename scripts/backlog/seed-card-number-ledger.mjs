#!/usr/bin/env node
/** Reviewed legacy seed. Dry-run by default; never changes a card or pushes main. */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { HASH_RE } from './id.mjs';
import { appendCardLedgerRows, cardLedgerBase, cardLedgerPath, sizedCardLedgerRun } from '../lib/card-number-ledger.mjs';
export const LEGACY_IDENTITIES_PATH = 'scripts/settings/card-ledger-legacy-identities.json';
const validId = id => typeof id === 'string' && id.length === 7 && HASH_RE.test(id);
function validateLegacy(legacy) {
  if (!Array.isArray(legacy)) throw new Error('invalid legacy identities; review allowlist on main');
  const seen = new Set();
  for (const e of legacy) {
    if (!validId(e?.id) || seen.has(e.id) || !Array.isArray(e.nums) || e.nums.length < 2
      || e.nums.some(n => !Number.isInteger(n) || n < 1 || n >= 100000) || new Set(e.nums).size !== e.nums.length
      || !e.nums.includes(e.canonical) || typeof e.reason !== 'string' || !e.reason.trim()) throw new Error('invalid legacy identity entry');
    seen.add(e.id);
  }
  return legacy;
}
export function buildSeedRows({ cards, legacy = [], now = () => new Date().toISOString() }) {
  validateLegacy(legacy);
  const identities = new Map(), rows = [], errors = [], warnings = [];
  for (const card of cards) {
    const number = /^backlog\/(\d{1,5})-[^/]+\.md$/.exec(card.path);
    if (!number || Number(number[1]) === 0) continue;
    // YAML ends at the first frontmatter closing delimiter. Body quotes are not identities.
    const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(card.text);
    if (!front) continue;
    let data;
    try { data = yaml.safeLoad(front[1]); } catch { errors.push(`invalid frontmatter: ${card.path}`); continue; }
    if (!data || !Object.hasOwn(data, 'bornAs')) continue;
    if (!validId(data.bornAs)) { errors.push(`invalid bornAs: ${card.path}`); continue; }
    if (!identities.has(data.bornAs)) identities.set(data.bornAs, []);
    identities.get(data.bornAs).push(Number(number[1]));
  }
  for (const [id, nums] of identities) {
    const allowed = legacy.find(e => e.id === id);
    if (nums.length > 1 && (!allowed || nums.some(n => !allowed.nums.includes(n)))) {
      errors.push(`unlisted duplicate bornAs ${id}: ${nums.join(', ')}`); continue;
    }
    if (new Set(nums).size !== nums.length) { errors.push(`duplicate numeric card filename for ${id}`); continue; }
    if (allowed && nums.some(n => !allowed.nums.includes(n))) { errors.push(`identity outside listed numbers: ${id}`); continue; }
    if (allowed && allowed.nums.some(n => !nums.includes(n))) warnings.push(`stale legacy entry ${id}: fewer listed cards remain`);
    const num = allowed && nums.includes(allowed.canonical) ? allowed.canonical : Math.min(...nums);
    rows.push({ id, num, pr: null, at: now(), by: 'drain', kind: 'seed' });
  }
  return { rows, errors, warnings };
}
export function seedCardNumberLedger({ repo = 'we', board = process.cwd(), cards, run = sizedCardLedgerRun(), append = appendCardLedgerRows,
  apply = false, env = process.env, base, ...options } = {}) {
  cardLedgerPath(repo);
  const root = JSON.parse(run(['show', `${cardLedgerBase({ base, env })}:${LEGACY_IDENTITIES_PATH}`], { cwd: board }));
  if (!root || !Object.hasOwn(root, repo)) throw new Error('missing base legacy identities for repo');
  if (!cards) cards = readdirSync(join(board, 'backlog')).filter(n => /^\d{1,5}-.+\.md$/.test(n)).map(name => ({ path: `backlog/${name}`, text: readFileSync(join(board, 'backlog', name), 'utf8') }));
  const result = buildSeedRows({ cards, legacy: root[repo] });
  if (apply && result.errors.length) throw new Error(`seed refused: ${result.errors.join('; ')}`);
  if (apply && result.rows.length) append({ ...options, board, repo, rows: result.rows, attempts: 1, env, base });
  return { ...result, applied: apply && !result.errors.length };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const repo = process.argv.find(a => a.startsWith('--repo='))?.slice(7) || 'we';
    const keyPath = process.env.WE_CARD_LEDGER_SIGNING_KEY;
    const result = seedCardNumberLedger({ repo, apply: process.argv.includes('--apply'), ...(keyPath ? { sign: { keyPath } } : {}) });
    console.log(JSON.stringify(result, null, 2));
    if (result.errors.length) process.exitCode = 1;
  } catch (e) { console.error(String(e.message).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 1000)); process.exitCode = 1; }
}
