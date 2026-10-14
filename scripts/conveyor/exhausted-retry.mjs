/** One durable retry after exhaustion — live PR #5195, 2026-10-14. */
import { readFileSync } from 'node:fs';
import { cascadePolicy, readPlatformPreferences } from '../lib/policy-cascade.mjs';
import { countCiHealComments, countChargeableCiHealComments } from './ci-heal-mark.mjs';
import { standDownComments, standDownReason, STAND_DOWN_REASONS, STAND_DOWN_MARKER } from './stand-down.mjs';

export const EXHAUSTED_RETRY_MARKER = '<!-- we:exhausted-retry -->';
export const EXHAUSTED_RETRY_SPENT_MARKER = '<!-- we:exhausted-retry-spent -->';

export function resolveExhaustedRetry({ env = process.env, platform, file = new URL('../settings/exhausted-retry.json', import.meta.url) } = {}) {
  let tool = file;
  if (typeof file === 'string' || file instanceof URL) {
    try { tool = JSON.parse(readFileSync(file, 'utf8')); } catch { tool = {}; }
  }
  platform ??= readPlatformPreferences({ env }).prefs;
  const number = key => {
    const raw = env?.[key];
    return raw === undefined ? undefined : typeof raw === 'string' && /^\d+(?:\.\d+)?$/.test(raw.trim()) ? Number(raw) : raw;
  };
  const flag = key => env?.[key] === undefined ? undefined : env[key] === '1' ? true : env[key] === '0' ? false : env[key];
  const c = cascadePolicy('fixLoop.exhaustedRetry', tool?.fixLoop?.exhaustedRetry, {
    env, platform: platform?.fixLoop?.exhaustedRetry ?? null,
    standard: { enabled: true, onMainMove: true, maxRetries: 1, afterHours: 12, lookbackHours: 72 },
    envValues: { enabled: flag('WE_EXHAUSTED_RETRY_ENABLED'), onMainMove: flag('WE_EXHAUSTED_RETRY_ON_MAIN_MOVE'),
      maxRetries: number('WE_EXHAUSTED_RETRY_MAX'), afterHours: number('WE_EXHAUSTED_RETRY_AFTER_HOURS') },
    valid: { enabled: v => typeof v === 'boolean', onMainMove: v => typeof v === 'boolean',
      maxRetries: v => Number.isInteger(v) && v >= 0,
      afterHours: v => typeof v === 'number' && Number.isFinite(v) && v >= 0,
      lookbackHours: v => typeof v === 'number' && Number.isFinite(v) && v >= 0 },
  });
  return { ...c.value, sources: c.sources, invalid: c.invalid };
}

export function exhaustionFacts({ comments = [], ciHealCap = 3, headSha = null } = {}) {
  const list = Array.isArray(comments) ? comments : [];
  const exhausted = [];
  if (countChargeableCiHealComments(list) >= ciHealCap) {
    const latest = list.filter(c => countCiHealComments([c]) > 0)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    exhausted.push({ exhausted: true, kind: 'ci-heal-exhausted', at: latest?.createdAt ?? null });
  }
  // Keep the exhaustion fact across a mechanical rebase; its retry budget is PR-wide.
  for (const c of standDownComments(list)) {
    const reason = standDownReason(c.body);
    // The shared reader returns prose for built comments and a key for legacy comments.
    if (reason === 'fix-loop-exhausted' || reason?.startsWith(STAND_DOWN_REASONS['fix-loop-exhausted'])) {
      exhausted.push({ exhausted: true, kind: 'fix-loop-exhausted', at: c.createdAt });
    }
  }
  return exhausted.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))[0]
    ?? { exhausted: false, kind: null, at: null };
}

export function countExhaustedRetries(comments) {
  return (Array.isArray(comments) ? comments : []).filter(c => String(typeof c === 'string' ? c : c?.body).includes(EXHAUSTED_RETRY_MARKER)).length;
}

export function planExhaustedRetry({ facts, retriesUsed = 0, settings, mainTip, aheadBy, now = Date.now(),
  mainFailureSignature = null, mainRecoveredForCheck = false } = {}) {
  if (!facts?.exhausted) return { action: 'none', why: 'not exhausted' };
  if (!settings.enabled || settings.maxRetries === 0) return { action: 'none', why: 'automatic retry after exhaustion is disabled' };
  const infra = mainFailureSignature?.signature
    ? `; ${mainFailureSignature.matched ? "matches main's own failure" : 'known infra signature'}: ${mainFailureSignature.signature}` : '';
  if (retriesUsed >= settings.maxRetries) return { action: 'needs-you',
    why: `the one automatic retry after exhaustion (${facts.kind}) was already used and the PR is still red — a person must take it over${infra}` };
  if (mainFailureSignature?.matched && !mainRecoveredForCheck) return { action: 'wait',
    why: `main still has the same failure; retrying now proves nothing${infra}` };
  const at = Date.parse(facts.at);
  const trigger = settings.onMainMove && aheadBy > 0 && Date.parse(mainTip?.committedAt) > at ? 'main-move'
    : settings.afterHours > 0 && now - at >= settings.afterHours * 3600000 ? 'after-hours' : null;
  if (!trigger) return { action: 'wait', why: `main has not moved past the exhaustion point yet${infra}` };
  if (!Number.isFinite(aheadBy) || aheadBy < 0) return { action: 'wait', why: `could not resolve how far behind main this head is${infra}` };
  return { action: 'retry', mode: aheadBy > 0 ? 'rebase' : 'rerun', trigger,
    why: `${trigger === 'main-move' ? 'main moved past the exhaustion point' : `${settings.afterHours} hours elapsed since exhaustion`}${infra}` };
}

export function buildExhaustedRetryComment({ prNumber, kind, trigger, mode, mainSha, headSha, why } = {}) {
  return `${EXHAUSTED_RETRY_MARKER}\nPR #${prNumber} exhausted ${kind} on ${headSha}; the product is retrying once (${trigger}): ${mode === 'rebase' ? `rebase onto main ${mainSha?.slice(0, 7)} then CI` : 'fresh CI re-run'}. ${why}. If it is still red afterwards it goes to the operator.`;
}

export function buildExhaustedRetrySpentComment({ kind, check, failingCheckName = check, headSha } = {}) {
  return `${STAND_DOWN_MARKER}\n${EXHAUSTED_RETRY_SPENT_MARKER}\nconveyor stopped rather than guessing: needs your decision: the automatic retry after ${kind} was used and ${failingCheckName} is still red on ${headSha?.slice(0, 7)}.\nhead: ${headSha}`;
}
