import { AsyncLocalStorage } from 'node:async_hooks';
import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readField } from '../backlog/frontmatter.mjs';
import { decideRuntimeAdmission, readBuildPrioritySettings } from './build-queue.mjs';

export { decideRuntimeAdmission };
const ticks = new AsyncLocalStorage();
const key = num => String(num ?? '').replace(/^#/, '');
const recoveryRoot = fileURLToPath(new URL('../../', import.meta.url));

/** Resolve aliases from the canonical backlog, never from a persisted payload's path or alias.
 * Missing cards retain their numeric identity; ambiguous/unreadable evidence refuses recovery. */
export function readRuntimeRecoveryIdentity(card, { root = recoveryRoot } = {}) {
  const num = key(card?.num);
  if (!/^(?:\d+|x[0-9a-z]{6,})(?![\s\S])/.test(num)) throw new Error('invalid recovery identity');
  const canonical = value => /^\d+$/.test(value) ? value.replace(/^0+(?=\d)/, '') : value;
  let names;
  try { names = readdirSync(join(root, 'backlog')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; names = []; }
  const matches = names.filter(name => {
    const token = /^(\d+|x[0-9a-z]{6,})-[^/]+\.md$/.exec(name)?.[1];
    return token && canonical(token) === canonical(num);
  });
  if (matches.length > 1) throw new Error('ambiguous recovery identity');
  const identity = { ...card, bornAs: undefined, id: undefined };
  if (!matches.length) return identity;
  const path = join(root, 'backlog', matches[0]);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('unreadable recovery identity');
  const bornAs = readField(readFileSync(path, 'utf8'), 'bornAs');
  if (bornAs !== undefined && !/^x[0-9a-z]{6,}(?![\s\S])/.test(bornAs)) throw new Error('invalid recovery alias');
  return { ...identity, bornAs };
}

/** Absent means no group; malformed persisted evidence requires operator repair. */
export function validRuntimeGroupMembers(members) {
  return members === undefined || (Array.isArray(members) && Array.from(members).every(member =>
    ['string', 'number'].includes(typeof member) && /^(?:\d+|x[0-9a-z]{6,})(?![\s\S])/.test(key(member))));
}

/** Fresh IO at every boundary. A refusal is data, never an exception escaping a tick. */
export function assertRuntimeAdmitted(card, kind, { readSettings, readIdentity } = {}) {
  const tick = ticks.getStore();
  let identity = { ...tick?.cards.get(key(card?.num)), ...Object.fromEntries(Object.entries(card ?? {}).filter(([, value]) => value !== undefined)) };
  let settings;
  try {
    if (kind === 'infra-recovery') identity = (readIdentity ?? tick?.readIdentity ?? readRuntimeRecoveryIdentity)(identity);
    settings = (readSettings ?? tick?.readSettings ?? readBuildPrioritySettings)();
  }
  catch { settings = { held: true }; }
  const decision = decideRuntimeAdmission(identity, kind, settings ?? null);
  if (!decision.admitted && tick) {
    const refusal = { num: key(card?.num), kind, reason: decision.reason };
    if (!tick.refused.some(r => r.num === refusal.num && r.kind === kind && r.reason === refusal.reason)) tick.refused.push(refusal);
  }
  return decision;
}

export function setRuntimeAdmissionCards(cards) {
  const tick = ticks.getStore();
  if (tick) for (const card of cards) tick.cards.set(key(card.num), card);
}

/** Tick-local reporting, with no settings cached between calls or ticks. */
export async function withRuntimeAdmissionTick(readSettings, run) {
  const tick = { readSettings, cards: new Map(), refused: [] };
  return ticks.run(tick, async () => {
    try {
      const result = await run();
      if (tick.refused.length) result.runtimeRefused = tick.refused;
      return result;
    } finally {
      if (tick.refused.length) console.error(`runtime admission refused: ${JSON.stringify(tick.refused)}`);
    }
  });
}

/** @typedef {{outcome: 'runtime-refused', refused: true, held: true, ok: false, spawned: false, dispatching: false, reason: string, detail: string, runtimeRefused: Array<{num: string, kind: string, reason: string}>}} RuntimeRefused */

/** The only launch boundary. Read once, admit the complete group, then invoke the effect
 * synchronously, with no IO or await between admission and invocation. Preserves sync/async
 * effects. Callers must forward persisted groupMembers, including on recovery paths.
 * Refusals retain the work for a later tick or operator repair of malformed evidence.
 * @template T
 * @param {object|object[]} card
 * @param {string} kind
 * @param {() => T} effect
 * @param {{readSettings?: Function, readIdentity?: Function}} [options]
 * @returns {T|RuntimeRefused}
 */
export function withRuntimeAdmission(card, kind, effect, { readSettings, readIdentity } = {}) {
  const tick = ticks.getStore();
  const reader = readSettings ?? tick?.readSettings ?? readBuildPrioritySettings;
  const identityReader = readIdentity ?? tick?.readIdentity ?? readRuntimeRecoveryIdentity;
  // Batch ports (hold routing) retain their single-call contract. Each row still
  // carries its own full persisted group; admission of the batch is atomic too.
  const cards = Array.isArray(card) ? card : [card];
  const identities = [...(tick?.roster ?? [])];
  let invalid = false;
  for (const lead of cards) {
    const members = lead?.groupMembers === undefined ? [] : lead.groupMembers;
    const persisted = tick?.cards.get(key(lead?.num))?.groupMembers;
    const malformed = !validRuntimeGroupMembers(members)
      || (persisted !== undefined && (!validRuntimeGroupMembers(persisted)
        || persisted.some(member => !members.some(num => key(num) === key(member)))));
    invalid ||= malformed;
    identities.push({ card: { ...lead }, kind });
    if (!malformed) for (const num of new Set(members.map(key))) {
      if (num !== key(lead?.num)) identities.push({ card: { num }, kind: kind.startsWith('prepare') ? 'prepare' : kind });
    }
  }
  // Resolve durable aliases before the final settings snapshot. Nested launch ports
  // inherit the reader and revalidate aliases along with their enclosing roster.
  const resolved = identities.map(identity => {
    try { return identity.kind === 'infra-recovery' ? { ...identity, card: identityReader(identity.card) } : identity; }
    catch { invalid = true; return identity; }
  });
  let settings;
  try { settings = reader(); }
  catch { settings = null; }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) || typeof settings.then === 'function') settings = null;
  // Even a batch with no identities must prove that settings permit the effect.
  if (!cards.length && !resolved.length
    && decideRuntimeAdmission({}, kind, settings).reason === 'runtime-malformed') resolved.push({ card: {}, kind });
  const runtimeRefused = [];
  for (const { card: identity, kind: identityKind } of resolved) {
    const decision = assertRuntimeAdmitted(identity, identityKind, { readSettings: () => invalid ? null : settings, readIdentity: () => identity });
    if (!decision.admitted && !runtimeRefused.some(refusal => refusal.num === key(identity?.num)
      && refusal.kind === identityKind && refusal.reason === decision.reason)) {
      runtimeRefused.push({ num: key(identity?.num), kind: identityKind, reason: decision.reason });
    }
  }
  if (runtimeRefused.length) return {
    outcome: 'runtime-refused', refused: true, held: true, ok: false, spawned: false, dispatching: false,
    reason: runtimeRefused[0].reason, detail: runtimeRefused[0].reason, runtimeRefused,
  };
  // Nested provider ports inherit the reader, never its snapshot. Every nested
  // launch re-reads it and checks every enclosing roster, including a trust retry
  // or a fallback provider that projects only the lead identity.
  return ticks.run({ readSettings: reader, readIdentity: identityReader, roster: identities, cards: tick?.cards ?? new Map(), refused: tick?.refused ?? [] }, effect);
}
