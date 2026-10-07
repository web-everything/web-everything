/**
 * The `pr-state.hold` extension point: mode `all` (every rule runs, the strictest wins), effect `restrict`
 * (a rule can only add a hold, never clear one), and a rule that throws or returns junk holds the PR with
 * `rule-crashed:<id>`; it never merges. Rules are pure: `evaluate(ctx) -> null | Hold | Hold[]`.
 * Hold = { code, reason, needsYou?: string|null }. The built-in rules ALWAYS run; `settings.holdRules` can only
 * add rules next to them (an empty or partial list never disables a built-in).
 */
import verdict from './verdict.mjs';
import referralUnruled from './referral-unruled.mjs';
import sameHeadCap from './same-head-cap.mjs';
import sendBack from './send-back.mjs';
import drainHold from './drain-hold.mjs';
import labelInput from './label-input.mjs';

export const HOLD_EXTENSION_POINT = Object.freeze({ name: 'pr-state.hold', mode: 'all', effect: 'restrict', onCrash: 'refuse' });
export const HOLD_RULES = Object.freeze([verdict, referralUnruled, sameHeadCap, sendBack, drainHold, labelInput]);

const valid = h => h && typeof h === 'object' && typeof h.code === 'string' && h.code && typeof h.reason === 'string';

/** @returns {Array<{code:string,reason:string,needsYou:string|null,rule:string}>} */
export function evaluateHolds(ctx, extraRules = []) {
  const holds = [];
  for (const rule of [...HOLD_RULES, ...(Array.isArray(extraRules) ? extraRules : [])]) {
    let out;
    try {
      out = rule.evaluate(ctx);
      const list = out == null ? [] : Array.isArray(out) ? out : [out];
      if (!list.every(valid)) throw new TypeError('malformed hold');
      for (const h of list) holds.push({ code: h.code, reason: h.reason, needsYou: h.needsYou ?? null, rule: rule.id });
    } catch (e) {
      holds.push({ code: `rule-crashed:${rule?.id ?? 'unknown'}`, reason: `hold rule ${rule?.id ?? 'unknown'} crashed: ${String(e?.message ?? e).slice(0, 120)}`, needsYou: null, rule: rule?.id ?? 'unknown' });
    }
  }
  return holds;
}
