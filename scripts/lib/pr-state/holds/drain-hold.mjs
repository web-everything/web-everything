import { EVENT_TYPES } from '../../verdict-ledger.mjs';
/** Generic hold / release events (drain, load-flake, ci-heal loop, operator). The last event per (source, reason) wins. */
export default {
  id: 'drain-hold',
  evaluate({ view }) {
    const last = new Map();
    for (const e of view.events) {
      if (e.type === EVENT_TYPES.HOLD || e.type === EVENT_TYPES.RELEASE) last.set(JSON.stringify([e.holdSource, e.reasonCode]), e); // a joined string would let "a:b"+"c" collide with "a"+"b:c"
    }
    const open = [...last.values()].filter(e => e.type === EVENT_TYPES.HOLD);
    return open.length ? open.map(e => ({ code: `hold:${e.holdSource}:${e.reasonCode}`, reason: `${e.holdSource} hold: ${e.reasonCode}` })) : null;
  },
};
