/**
 * delivery-strategy: pure selector that decides how a step is delivered (S1.1 of STRATEGY-SELECTOR).
 *
 *   selectStrategy(inputs, settings, now) -> { strategy, reasonCode, why, inputsUsed }
 *
 * No IO. Every input is `{ value, at }`; a missing, 'unknown' or stale (older than settings.staleMin)
 * input is unknown, and a needed unknown input always yields hold/input-unknown, never prototype-first
 * or incident. Thresholds come only from scripts/settings/delivery-strategy.json: a missing key yields
 * hold/settings-missing. Rules are tried in order, first match wins.
 * Names are pending the Standards spec ship/delivery-strategy; they live only in this module.
 */

export const STRATEGIES = Object.freeze({
  NORMAL_PR: 'normal-pr',
  PROTOTYPE_FIRST: 'prototype-first',
  BUILD_AHEAD: 'build-ahead',
  STACKED: 'stacked',
  INCIDENT: 'incident',
  DESIGN_PASS_FIRST: 'design-pass-first',
  HOLD: 'hold',
});

export const REASONS = Object.freeze({
  INPUT_UNKNOWN: 'input-unknown',
  SETTINGS_MISSING: 'settings-missing',
  AWAIT_ADOPTION: 'await-adoption',
  GATE_FIX_UNLOADED: 'gate-fix-unloaded',
  STAGE_STRESSED: 'stage-stressed',
  UNBLOCKS_PR: 'unblocks-pr',
  INCIDENT: 'incident',
  DAEMON_FIX: 'daemon-fix-audited',
  NEEDS_DESIGN: 'needs-design-pass',
  STACK_PARENT_OPEN: 'stack-parent-open',
  DEFAULT: 'default',
});

export const SETTINGS_KEYS = Object.freeze([
  'staleMin',
  'daemonKinds',
  'prototypeLoadWithinMin',
  'designPassAfterRounds',
  'buildAheadMax',
  'unblockerCap',
]);

const REQUIRED_INPUTS = ['stages', 'kind', 'audit', 'daemonsAdopting', 'overlayLoadable', 'prep', 'rounds'];
const SHA40 = /^[0-9a-f]{40}$/;

function result(strategy, reasonCode, why, inputsUsed) {
  return { strategy, reasonCode, why, inputsUsed };
}

/** True when the audit is green and bound to exactly the current 40-hex head. */
export function auditGreen(audit) {
  if (!audit || typeof audit !== 'object') return false;
  if (!SHA40.test(String(audit.sha || '')) || audit.sha !== audit.head) return false;
  if (audit.tests !== 'green') return false;
  if (audit.verdict === 'NOT WEAKENED') return true;
  return audit.verdict === 'WEAKENED' && audit.rulingAccepted === true;
}

export function selectStrategy(inputs, settings, now) {
  const used = [];
  const hasSettings =
    settings && typeof settings === 'object' && SETTINGS_KEYS.every((k) => settings[k] !== undefined && settings[k] !== null);
  if (!hasSettings) {
    return result(STRATEGIES.HOLD, REASONS.SETTINGS_MISSING, 'a required delivery-strategy setting is missing', used);
  }
  const inp = inputs && typeof inputs === 'object' ? inputs : {};
  const staleMs = settings.staleMin * 60_000;
  const t = Number.isFinite(now) ? now : Date.now();
  const known = (name) => {
    const i = inp[name];
    if (!i || typeof i !== 'object' || i.value === undefined || i.value === 'unknown') return false;
    return Number.isFinite(i.at) && t - i.at <= staleMs;
  };
  const val = (name) => {
    used.push(name);
    return inp[name]?.value;
  };
  const opt = (name, fallback) => (inp[name] && inp[name].value !== undefined ? val(name) : fallback);

  // Rule 1: any needed input unknown or stale -> hold.
  const missing = REQUIRED_INPUTS.filter((n) => !known(n));
  if (missing.length) {
    return result(STRATEGIES.HOLD, REASONS.INPUT_UNKNOWN, `unknown or stale input: ${missing.join(', ')}`, used);
  }

  const stages = val('stages') || {};
  const kind = val('kind');
  const audit = val('audit');
  const adopting = val('daemonsAdopting') === true;
  const overlay = val('overlayLoadable') === true;
  const prep = val('prep') || {};
  const rounds = val('rounds');
  const rank = opt('blockerRank', null);
  const green = auditGreen(audit);
  const daemonKind = settings.daemonKinds.includes(kind);

  // Rule 2
  if (!adopting && rank === 1 && green) {
    return result(STRATEGIES.INCIDENT, REASONS.INCIDENT, 'daemons held, rank-1 blocker fix audited green: ask for force-merge', used);
  }
  // Rule 3
  if (!adopting && daemonKind && green) {
    return result(STRATEGIES.HOLD, REASONS.AWAIT_ADOPTION, 'daemon fix audited green; load when daemons adopt', used);
  }
  // Rule 4
  if (adopting && daemonKind && overlay && green) {
    return result(
      STRATEGIES.PROTOTYPE_FIRST,
      REASONS.DAEMON_FIX,
      `load within ${settings.prototypeLoadWithinMin} min of the audit; rank ${rank ?? 'none'}`,
      used,
    );
  }
  // Rule 5
  if (!prep.ok || rounds >= settings.designPassAfterRounds) {
    return result(STRATEGIES.DESIGN_PASS_FIRST, REASONS.NEEDS_DESIGN, !prep.ok ? 'no usable prep' : `${rounds} rounds so far`, used);
  }
  // Rule 6
  const parent = opt('stackParent', null);
  if (parent && parent.merged !== true) {
    return result(STRATEGIES.STACKED, REASONS.STACK_PARENT_OPEN, 'stack parent PR is not merged', used);
  }
  // Rule 7
  const loads = opt('loadsStages', []);
  const stressed = loads.filter((s) => stages[s] && stages[s] !== 'ok');
  if (stressed.length) {
    if (
      stressed.length === 1 &&
      stressed[0] === 'wip' &&
      opt('unblocksPrs', false) === true &&
      opt('unblockerCount', 0) < settings.unblockerCap
    ) {
      return result(STRATEGIES.NORMAL_PR, REASONS.UNBLOCKS_PR, 'only wip stressed and the step unblocks waiting PRs', used);
    }
    if (opt('knownIncidentFixLanded', false) === true && opt('buildAheadCount', 0) < settings.buildAheadMax) {
      return result(STRATEGIES.BUILD_AHEAD, REASONS.INCIDENT, 'stress from a known incident whose fix landed', used);
    }
    if (opt('gateFixUnloaded', false) === true && loads.includes('redteam')) {
      return result(STRATEGIES.HOLD, REASONS.GATE_FIX_UNLOADED, 'a gate fix is still unloaded and the step loads redteam', used);
    }
    return result(STRATEGIES.HOLD, REASONS.STAGE_STRESSED, `stressed: ${stressed.join(', ')}`, used);
  }
  // Rule 8
  return result(STRATEGIES.NORMAL_PR, REASONS.DEFAULT, 'no rule matched', used);
}
