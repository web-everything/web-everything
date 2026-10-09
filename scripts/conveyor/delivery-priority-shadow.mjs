/**
 * @file scripts/conveyor/delivery-priority-shadow.mjs
 * @description Card xjddimd (epic x8juafk) — SHADOW adapter for the delivery priority class rule
 *   (we:scripts/lib/delivery-priority.mjs). It turns the fix daemon's own pass data into plain facts, ranks them,
 *   and logs one `priority-shadow` line per pass. It never changes an order, refusal or dispatch: the consumers that
 *   sort by class are slice x3r5fzx.
 *
 *   Forge-specific reads live HERE, never in the rule: label strings, repo-relative paths, and the main-red owner
 *   record that card 5510 publishes (`<coordination root>/main-red-priority.json`, written by
 *   we:scripts/lib/main-red-priority.mjs once PR #4527 lands: `{repo, pr, expiresAt, ...}` = "while main is red,
 *   PR #N owns the fix"). Until that record exists, nothing is P0 live — the honest shadow result.
 *
 *   Override labels are read but never verified as operator-set here (no writer check yet; that ships with x3r5fzx),
 *   so the rule ignores them and the log names them "not verified".
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { rankByDeliveryPriority, resolvePrioritySettings } from '../lib/delivery-priority.mjs';

export const DELIVERY_PRIORITY_SETTINGS_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'delivery-priority-settings.json');
export const PRIORITY_OVERRIDE_LABELS = Object.freeze({ 'priority:urgent': 'urgent', 'priority:low': 'low' });

/** Declared settings, resolved; any read or parse failure gives the off value. */
export function readDeliveryPrioritySettings({ path = DELIVERY_PRIORITY_SETTINGS_PATH, read = readFileSync } = {}) {
  try { return resolvePrioritySettings(JSON.parse(String(read(path, 'utf8'))).deliveryPriority); } catch { return resolvePrioritySettings(undefined); }
}

/** The live main-red owner record `{repo, pr}`, or null (absent, unreadable, malformed, expired). */
export function readMainRedOwner({ env = process.env, now = Date.now(), read = readFileSync, path } = {}) {
  try {
    const file = path ?? join(resolveCoordinationRoot({ env }), 'main-red-priority.json');
    const r = JSON.parse(String(read(file, 'utf8')));
    return r && Number.isInteger(r.pr) && Number.isFinite(r.expiresAt) && now < r.expiresAt ? { repo: r.repo ?? null, pr: r.pr } : null;
  } catch { return null; }
}

const isCodeFree = (path) => /^(backlog|docs)\//.test(path) || /\.md$/i.test(path);

/**
 * Plain facts for one planned fix/ci-heal entry. PURE.
 * @param {object} entry   a planned entry of `runReconcileFixDispatch` (pr, waitingSince, overlapScope, operatorAnswer…)
 * @param {{rank?:{blocks?:number}, owner?:{repo:string|null, pr:number}|null, repoKey?:string, labels?:string[]}} ctx
 */
export function fixEntryPriorityFacts(entry, { rank = null, owner = null, repoKey = 'we', labels = [] } = {}) {
  const paths = Array.isArray(entry?.overlapScope) ? entry.overlapScope.map((p) => String(p).replace(/^[a-z-]+:/, '')) : null;
  const overrideLabel = (Array.isArray(labels) ? labels : []).find((l) => PRIORITY_OVERRIDE_LABELS[l]);
  return {
    incident: owner ? { open: true, owner: owner.pr === entry?.pr && (owner.repo == null || owner.repo === repoKey) } : { open: false },
    scopeWaiters: Number(rank?.blocks) || 0,
    operatorRequested: Boolean(entry?.operatorAnswer || entry?.operatorSendBack),
    ...(paths && paths.length ? { changesCode: paths.some((p) => !isCodeFree(p)) } : {}),
    ...(overrideLabel ? { override: { value: PRIORITY_OVERRIDE_LABELS[overrideLabel], byOperator: false } } : {}),
    ...(entry?.waitingSince ? { waitingSince: entry.waitingSince } : {}),
  };
}

/**
 * Rank one fix pass in shadow. PURE.
 * @returns {{mode:string, ranked:Array<object>}}
 */
export function shadowFixPassPriority({ planned = [], ranks = [], dispatchEntries = [], repoKey = 'we', settings, owner = null, now }) {
  const rankByPr = new Map((ranks ?? []).map((r) => [r.pr, r]));
  const labelsByPr = new Map((dispatchEntries ?? []).map((e) => [Number(e.prNumber), e.labels ?? []]));
  const items = (planned ?? []).map((entry) => ({
    id: entry.pr,
    facts: fixEntryPriorityFacts(entry, { rank: rankByPr.get(entry.pr), owner, repoKey, labels: labelsByPr.get(entry.pr) }),
  }));
  return { mode: settings.mode, ranked: rankByDeliveryPriority(items, settings, now) };
}

/** One log line for a pass. PURE. */
export function formatPriorityShadowLine(repoKey, { mode, ranked }) {
  const parts = ranked.map((r) => `#${r.id} ${r.class} score ${r.score} (${r.reasons.join('; ')})`);
  return `reconcile-fix-dispatch: priority-shadow ${repoKey} mode=${mode} ${ranked.length} PR(s) — ${parts.join(' | ') || 'none owed'}`;
}

/**
 * IO shell: read settings + owner record, rank, log. Best-effort: never throws, never changes the pass.
 * Mode `off`, or a pass with nothing owed, logs nothing. Returns the shadow result or null.
 */
export function logFixPassPriorityShadow({
  planned, ranks, dispatchEntries, repoKey = 'we', env = process.env, now = Date.now(), log = (line) => console.error(line),
  readSettings = readDeliveryPrioritySettings, readOwner = () => readMainRedOwner({ env, now }),
} = {}) {
  try {
    if (!Array.isArray(planned) || !planned.length) return null; // nothing owed this pass: nothing to class
    const settings = readSettings();
    if (settings.mode === 'off') return null;
    const result = shadowFixPassPriority({ planned, ranks, dispatchEntries, repoKey, settings, owner: readOwner(), now });
    log(formatPriorityShadowLine(repoKey, result));
    return result;
  } catch (e) {
    try { log(`reconcile-fix-dispatch: priority-shadow skipped: ${String(e?.message ?? e).split('\n')[0]}`); } catch { /* never fail the pass */ }
    return null;
  }
}
