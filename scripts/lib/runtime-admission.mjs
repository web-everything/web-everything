import { AsyncLocalStorage } from 'node:async_hooks';
import { decideRuntimeAdmission, readBuildPrioritySettings } from './build-queue.mjs';

export { decideRuntimeAdmission };
const ticks = new AsyncLocalStorage();
const key = num => String(num ?? '').replace(/^#/, '');

/** Fresh IO at every boundary. A refusal is data, never an exception escaping a tick. */
export function assertRuntimeAdmitted(card, kind, { readSettings } = {}) {
  const tick = ticks.getStore();
  const identity = { ...tick?.cards.get(key(card?.num)), ...Object.fromEntries(Object.entries(card ?? {}).filter(([, value]) => value !== undefined)) };
  let settings;
  try { settings = (readSettings ?? tick?.readSettings ?? readBuildPrioritySettings)(); }
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
 * @param {{readSettings?: Function}} [options]
 * @returns {T|RuntimeRefused}
 */
export function withRuntimeAdmission(card, kind, effect, { readSettings } = {}) {
  const tick = ticks.getStore();
  const reader = readSettings ?? tick?.readSettings ?? readBuildPrioritySettings;
  let settings;
  try { settings = reader(); }
  catch { settings = null; }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) || typeof settings.then === 'function') settings = null;
  // Batch ports (hold routing) retain their single-call contract. Each row still
  // carries its own full persisted group; admission of the batch is atomic too.
  const cards = Array.isArray(card) ? card : [card];
  const identities = [];
  let invalid = false;
  for (const lead of cards) {
    const members = lead?.groupMembers === undefined ? [] : lead.groupMembers;
    const persisted = tick?.cards.get(key(lead?.num))?.groupMembers;
    const malformed = !Array.isArray(members) || members.some(member =>
      !['string', 'number'].includes(typeof member) || !String(member).trim())
      || (persisted !== undefined && (!Array.isArray(persisted)
        || persisted.some(member => !members.some(num => key(num) === key(member)))));
    invalid ||= malformed;
    identities.push({ card: lead, kind });
    if (!malformed) for (const num of new Set(members.map(key))) {
      if (num !== key(lead?.num)) identities.push({ card: { num }, kind: kind.startsWith('prepare') ? 'prepare' : kind });
    }
  }
  const runtimeRefused = [];
  for (const { card: identity, kind: identityKind } of identities) {
    const decision = assertRuntimeAdmitted(identity, identityKind, { readSettings: () => invalid ? null : settings });
    if (!decision.admitted) runtimeRefused.push({ num: key(identity?.num), kind: identityKind, reason: decision.reason });
  }
  if (runtimeRefused.length) return {
    outcome: 'runtime-refused', refused: true, held: true, ok: false, spawned: false, dispatching: false,
    reason: runtimeRefused[0].reason, detail: runtimeRefused[0].reason, runtimeRefused,
  };
  // Nested provider ports inherit the reader, never its snapshot. Every nested
  // launch re-reads it, including a trust retry or a fallback provider.
  return ticks.run({ readSettings: reader, cards: tick?.cards ?? new Map(), refused: tick?.refused ?? [] }, effect);
}
