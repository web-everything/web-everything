/**
 * @file scripts/conveyor/bundle-repair-core.mjs
 * @description PROTOTYPE (operator OK 2026-10-21 ~17:15 ET) — the PURE CORE of the supervised "bundle repair" job:
 *   when a daemon clone sits held on its last-good build because its registered overlays conflict with a new main
 *   (`daemon-rebuild: established-overlay-hold`), the health watch launches ONE headless repair session for that
 *   clone, which rebuilds one fresh overlay top (origin/main + every registered overlay, conflicts resolved keeping
 *   both sides), proves it, and registers it. This automates the manual "unfreeze" orchestrator agents did three
 *   times on 2026-10-21 (lane/unfreeze-review-top-1021b, lane/unfreeze-drain-top-1021, lane/unfreeze-review-top-1021c).
 *   `overlay.autoRebase` stays in shadow; this job is the supervised alternative.
 *
 *   No fs, no child_process, no clock. The IO shell (we:scripts/conveyor/bundle-repair-dispatch.mjs) reads the
 *   clone hold state, the ledger and the kill switch, hands them in here, and performs what this module decides.
 *
 * What lives here:
 *   1. {@link planBundleRepairs} — which held clones get a repair session THIS tick, and why each other one is held
 *      back: off / kill switch / clone not selected / hold younger than the trigger / one repair per clone / one
 *      attempt per hold / max concurrent.
 *   2. {@link planReconcile} — what happens to each running repair: hold cleared, outcome recorded, conflict
 *      override detected, wall time reached. Every bad ending is an ESCALATION (operator alert), never a retry.
 *   3. {@link validateOutcome} — the session's one write, shape-checked. Two WEAKENED audits can only be recorded
 *      as an escalation.
 *   4. {@link assertBriefSafe} — the filled brief never carries a forbidden command (the conflict override, a force
 *      push, a hook bypass). Checked on every brief before it is launched OR posted in shadow.
 */

export const BUNDLE_REPAIR_KIND = 'bundle-repair';
/** The `--by=` identity every registration the repair session makes carries (never the operator). */
export const BUNDLE_REPAIR_BOT = 'bundle-repair-bot';
/** `rebuild.json#held.reason` values that mean "the registered overlays conflict with main". */
export const OVERLAY_HOLD_REASONS = Object.freeze(['established-overlay-conflict', 'pinned-overlay-conflict']);
/** Two WEAKENED audit verdicts and the session must stop and escalate (operator brief, 2026-10-21). */
export const MAX_WEAKENED = 2;
export const MODES = Object.freeze(['shadow', 'live']);

/** The STANDARD layer of the `bundleRepair` policy cascade. Off by default; shadow first. */
export const BUNDLE_REPAIR_STANDARD = Object.freeze({
  enabled: false,
  mode: 'shadow',
  triggerMinutes: 20,
  clones: Object.freeze(['*']),
  maxConcurrent: 1,
  wallTimeMinutes: 120,
});

const int = (lo, hi) => (v) => Number.isSafeInteger(v) && v >= lo && v <= hi;
/** Per-leaf validity — an invalid value never overrides a lower layer (`policy-cascade.mjs#resolveCascade`). */
export const BUNDLE_REPAIR_VALID = Object.freeze({
  enabled: (v) => typeof v === 'boolean',
  mode: (v) => MODES.includes(v),
  triggerMinutes: int(1, 24 * 60),
  clones: (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim() !== ''),
  maxConcurrent: int(1, 4),
  wallTimeMinutes: int(10, 8 * 60),
});

export const LEDGER_STATUSES = Object.freeze(['running', 'repaired', 'shadow', 'cleared', 'escalated', 'dispatch-failed']);
export const ESCALATION_REASONS = Object.freeze([
  'weakened-twice', 'unresolvable-conflict', 'tests-regressed', 'conflict-override-used', 'wall-time', 'hold-not-cleared',
  'dispatch-failed', 'other',
]);
/** What the session itself may record as its reason to stop (the rest are the tick's own findings). */
export const SESSION_ESCALATION_REASONS = Object.freeze(['weakened-twice', 'unresolvable-conflict', 'tests-regressed', 'other']);

export const HOLD_RULES = Object.freeze({
  NOT_OVERLAY_HOLD: 'not-overlay-hold',
  NOT_SELECTED: 'not-selected',
  UNKNOWN_ROOT: 'unknown-root',
  UNDER_TRIGGER: 'under-trigger',
  ONE_PER_CLONE: 'one-per-clone',
  ONE_PER_HOLD: 'one-per-hold',
  MAX_CONCURRENT: 'max-concurrent',
});

const MINUTE = 60_000;

/** PURE: the short clone name the operator uses (`wev-review-daemon` → `review`, `.lanes/we-drain-daemon/code` →
 *  `we-drain-code`). */
export function cloneName(root) {
  const parts = String(root ?? '').split('/').filter(Boolean);
  const base = parts.at(-1) ?? '';
  const parent = parts.at(-2) ?? '';
  const strip = (s) => s.replace(/^wev-/, '').replace(/-daemon$/, '');
  const raw = parts.at(-3) === '.lanes' ? `${strip(parent)}-${base}` : strip(base);
  return raw.replace(/[^A-Za-z0-9_.-]/g, '-') || 'clone';
}

/** PURE: is this `held` record an overlay-conflict hold this job repairs? */
export function isOverlayHold(held) {
  return !!held && OVERLAY_HOLD_REASONS.includes(held.reason) && Number.isFinite(held.since);
}

/** PURE: the id of ONE hold episode on ONE clone — stable while the clone stays continuously held. */
export function holdIdFor({ root, cloneKey }, held) {
  return `${cloneName(root)}-${String(cloneKey).slice(0, 8)}-${Number(held.since).toString(36)}`;
}

/** PURE: does `clones` (setting) select this clone? `*` selects every clone; else a name, key or root. */
export function cloneSelected(clones, { root, cloneKey }) {
  const list = Array.isArray(clones) ? clones : [];
  return list.some((c) => c === '*' || c === cloneName(root) || c === cloneKey || c === root);
}

/** PURE: the refs a hold names (`failed: "lane/a, lane/b: conflict with main"`). */
export function heldRefs(held) {
  const text = String(held?.failed ?? '').replace(/:\s*conflict with main\s*$/, '');
  return text.split(',').map((s) => s.trim().replace(/\s*\(PR #\d+\)$/, '')).filter((s) => /^[A-Za-z0-9._/-]+$/.test(s));
}

/**
 * PURE: which held clones get a repair session this tick.
 * @param {{clones:Array<{cloneKey:string, root:string|null, held:object|null}>, ledger:Array<object>,
 *   settings:object, killed:boolean, now:number}} o
 * @returns {{off:false|'disabled'|'kill-switch', dispatch:Array<object>, held:Array<{cloneKey:string, rule:string, reason:string}>}}
 */
export function planBundleRepairs({ clones = [], ledger = [], settings = BUNDLE_REPAIR_STANDARD, killed = false, now }) {
  const s = { ...BUNDLE_REPAIR_STANDARD, ...settings };
  if (s.enabled !== true) return { off: 'disabled', dispatch: [], held: [] };
  if (killed) return { off: 'kill-switch', dispatch: [], held: [] };
  const entries = Array.isArray(ledger) ? ledger : [];
  let running = entries.filter((e) => e.status === 'running' || e.stopPending || (e.launching && now < e.deadlineAt)).length;
  const dispatch = [];
  const held = [];
  const candidates = clones.filter((c) => isOverlayHold(c?.held)).sort((a, b) => a.held.since - b.held.since);
  for (const c of clones) if (c && !isOverlayHold(c.held) && c.held) held.push({ cloneKey: c.cloneKey, rule: HOLD_RULES.NOT_OVERLAY_HOLD, reason: `held for ${c.held.reason}, not an overlay conflict` });
  for (const c of candidates) {
    const hold = (rule, reason) => held.push({ cloneKey: c.cloneKey, rule, reason });
    if (!c.root) { hold(HOLD_RULES.UNKNOWN_ROOT, 'no known daemon clone root hashes to this clone key'); continue; }
    if (!cloneSelected(s.clones, c)) { hold(HOLD_RULES.NOT_SELECTED, `clone ${cloneName(c.root)} is not in bundleRepair.clones`); continue; }
    const heldMin = (now - c.held.since) / MINUTE;
    if (heldMin < s.triggerMinutes) { hold(HOLD_RULES.UNDER_TRIGGER, `held ${Math.floor(heldMin)} min (trigger ${s.triggerMinutes} min)`); continue; }
    const holdId = holdIdFor(c, c.held);
    // Live = running, a session whose stop is pending, or a reservation whose launch is not patched in yet (bounded
    // by its deadline, so a crashed launcher cannot block the clone forever).
    const live = entries.find((e) => e.cloneKey === c.cloneKey && (e.status === 'running' || e.stopPending || (e.launching && now < e.deadlineAt)));
    if (live) { hold(HOLD_RULES.ONE_PER_CLONE, `a repair is already running on this clone (${live.session ?? live.holdId})`); continue; }
    const prior = entries.find((e) => e.holdId === holdId);
    if (prior) { hold(HOLD_RULES.ONE_PER_HOLD, `this hold already had its one repair attempt (${prior.status})`); continue; }
    if (s.mode === 'live' && running >= s.maxConcurrent) { hold(HOLD_RULES.MAX_CONCURRENT, `${running} repair(s) running (max ${s.maxConcurrent})`); continue; }
    dispatch.push({
      cloneKey: c.cloneKey, root: c.root, name: cloneName(c.root), holdId, holdSince: c.held.since,
      holdReason: c.held.reason, refs: heldRefs(c.held), lastGood: c.held.lastGood ?? null, mainSha: c.held.mainSha ?? null,
    });
    if (s.mode === 'live') running += 1;
  }
  return { off: false, dispatch, held };
}

/**
 * PURE: what to do with every RUNNING (or `repaired`, awaiting the hold to clear) ledger entry this tick.
 * Order of precedence, first match wins:
 *   1. a registration by the bot carried a conflict override → escalate `conflict-override-used` (also for a settled
 *      entry whose stop is still pending — its session may still be running — which also escalates `wall-time`
 *      once past its deadline). Each reason is raised at most once per entry (`entry.escalations`);
 *   2. the session recorded `escalate` → escalate with its reason (both outrank a cleared hold);
 *   3. the clone is held on nothing → `cleared` (escalating `wall-time` if the session overran without a timely
 *      outcome). A clone MISSING from the probe, or moved into ANOTHER hold, is not cleared;
 *   4. the wall time is reached → escalate `wall-time` (`hold-not-cleared` when the session said repaired);
 *   5. the session recorded `repaired` → stop it; status `repaired` (still watched until the hold clears).
 * @param {Array<object>} ledger
 * @param {{clones:Array<object>, now:number, outcomeFor:(holdId:string)=>object|null,
 *   overrideFor:(entry:object)=>object|null}} o
 * @returns {Array<{holdId:string, stop:boolean, status:string, escalate:string|null, detail:string}>}
 */
export function planReconcile(ledger, { clones = [], now, outcomeFor = () => null, overrideFor = () => null }) {
  const byKey = new Map(clones.map((c) => [c.cloneKey, c]));
  const out = [];
  for (const e of Array.isArray(ledger) ? ledger : []) {
    const watched = e.status === 'running' || e.status === 'repaired';
    // A settled entry whose stop failed may still have a live session: keep watching it — including the tick its
    // stop retry finally succeeded (`stopSettledAt === now`).
    if (!watched && !e.stopPending && e.stopSettledAt !== now) continue;
    const raised = new Set(e.escalations || []);
    const sessionLive = e.status === 'running';
    const mayRun = sessionLive || !!e.stopPending;
    const act = (status, escalate, detail, stop = mayRun) => out.push({ holdId: e.holdId, stop, status, escalate, detail });
    const pastDeadline = now >= e.deadlineAt;
    const override = overrideFor(e);
    if (override && !raised.has('conflict-override-used')) {
      act('escalated', 'conflict-override-used', `a registration by ${BUNDLE_REPAIR_BOT} carried a conflict override (${override.ref ?? '?'})`);
      continue;
    }
    if (!watched) {
      if ((e.stopPending || e.stopSettledAt === now) && pastDeadline && !raised.has('wall-time')) act(e.status, 'wall-time', 'the session could not be stopped before its wall time');
      continue;
    }
    const outcome = outcomeFor(e.holdId);
    if (outcome?.outcome === 'escalate' && sessionLive) { act('escalated', outcome.reason, outcome.detail); continue; }
    const saidRepaired = e.status === 'repaired' || (sessionLive && outcome?.outcome === 'repaired');
    const c = byKey.get(e.cloneKey);
    // CLEARED means the clone is known to be held on NOTHING. Missing from the probe, unreadable rebuild state
    // (`held === undefined`), or moved into ANOTHER hold (a smoke failure, a new overlay conflict) is not cleared.
    if (c && c.held === null) {
      const late = !outcome || !(Date.parse(outcome.recordedAt) <= e.deadlineAt);
      if (mayRun && pastDeadline && late && !raised.has('wall-time')) act('cleared', 'wall-time', 'the hold cleared, but the session ran past its wall time without recording an outcome in time');
      else act('cleared', null, 'the clone left this overlay hold');
      continue;
    }
    if (pastDeadline) {
      const reason = saidRepaired ? 'hold-not-cleared' : 'wall-time';
      if (!raised.has(reason)) {
        act('escalated', reason, saidRepaired ? 'the session said repaired but the clone is still held at the wall time' : 'the repair session reached its wall time without recording an outcome');
      }
      continue;
    }
    if (c && sessionLive && outcome?.outcome === 'repaired') act('repaired', null, `registered ${outcome.top}; waiting for the hold to clear`);
  }
  return out;
}

const TOP_RE = /^lane\/[A-Za-z0-9._/-]{1,120}$/;
const VERDICTS = new Set(['NOT WEAKENED', 'WEAKENED']);

/**
 * PURE: the session's `record` input. Throws with a message the agent can act on.
 * `{outcome:'repaired', top:'lane/…', audits:[{verdict}], detail}` or `{outcome:'escalate', reason, audits, detail}`.
 * A `repaired` record needs its LAST audit NOT WEAKENED and fewer than {@link MAX_WEAKENED} WEAKENED verdicts.
 */
export function validateOutcome(input, { scrub = (s) => s } = {}) {
  const fail = (m) => { throw new Error(`bundle-repair: outcome refused — ${m}`); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('expected a JSON object');
  const { outcome, audits = [], detail } = input;
  if (!['repaired', 'escalate'].includes(outcome)) fail('`outcome` must be "repaired" or "escalate"');
  if (!Array.isArray(audits) || audits.some((a) => !a || !VERDICTS.has(a.verdict))) fail('`audits` must be [{verdict:"NOT WEAKENED"|"WEAKENED"}]');
  if (typeof detail !== 'string' || !detail.trim()) fail('`detail` must be a non-empty string');
  const weakened = audits.filter((a) => a.verdict === 'WEAKENED').length;
  const clean = { audits: audits.map((a) => ({ verdict: a.verdict })), detail: scrub(detail.trim()).slice(0, 600) };
  if (outcome === 'repaired') {
    if (weakened >= MAX_WEAKENED) fail(`${weakened} WEAKENED audits — record outcome "escalate" with reason "weakened-twice"`);
    if (!audits.length || audits.at(-1).verdict !== 'NOT WEAKENED') fail('a repaired top needs a final NOT WEAKENED audit');
    if (typeof input.top !== 'string' || !TOP_RE.test(input.top)) fail('`top` must be the registered lane/… ref');
    return { outcome, top: input.top, ...clean };
  }
  if (!SESSION_ESCALATION_REASONS.includes(input.reason)) fail(`\`reason\` must be one of ${SESSION_ESCALATION_REASONS.join(', ')}`);
  return { outcome, reason: input.reason, ...clean };
}

/** Forbidden in any command the brief tells the session to run. `[pattern, why]`. */
export const FORBIDDEN_COMMANDS = Object.freeze([
  [/--allow-conflict\b/, 'the overlay conflict override'],
  [/\bgit\b[^\n]*\bpush\b[^\n]*(?:\s--force(?:-with-lease)?\b|\s-f\b|\s\+\S)/, 'a force push'],
  [/--no-verify\b/, 'a hook bypass'],
  [/WE_GITHUB_APP_ROLE=operator\b|--as-operator\b/, 'the operator credential'],
]);

/** PURE: throw when the brief carries a forbidden command anywhere (prose included — say it in words instead). */
export function assertBriefSafe(text) {
  const bad = [];
  String(text ?? '').split('\n').forEach((line, i) => {
    for (const [re, why] of FORBIDDEN_COMMANDS) if (re.test(line)) bad.push(`line ${i + 1}: ${why}`);
  });
  if (bad.length) throw new Error(`bundle-repair: the brief carries forbidden command(s) — ${bad.join('; ')}`);
  return true;
}

/** PURE: the needs-you item for one escalation (feed limits: reason ≤ 100 chars, head ≤ 128). */
export function escalationItem(entry, { reason, detail, host, weRoot }) {
  return {
    repo: `host/${host}`, pr: 0, head: `bundle-repair:${entry.holdId}`.slice(0, 128), kind: 'bundle-repair',
    reason: `${entry.name}: bundle repair stopped (${reason}) — ${detail ?? ''}`.slice(0, 100),
    episode: entry.holdId,
    pick: `node ${weRoot}/scripts/conveyor/bundle-repair-dispatch.mjs show --hold=${entry.holdId}`,
  };
}

/** PURE: drop settled entries older than 7 days; never a running/repaired one, never the current hold's tombstone. */
export function pruneLedger(ledger, { now, liveHoldIds = new Set() }) {
  return (Array.isArray(ledger) ? ledger : []).filter((e) => ['running', 'repaired'].includes(e.status)
    || e.stopPending || e.launching || e.escalationPending?.length || liveHoldIds.has(e.holdId) || now - (e.startedAt ?? 0) < 7 * 24 * 60 * MINUTE);
}
