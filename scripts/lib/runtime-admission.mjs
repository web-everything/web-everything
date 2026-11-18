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
export async function withRuntimeAdmission(readSettings, run) {
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
