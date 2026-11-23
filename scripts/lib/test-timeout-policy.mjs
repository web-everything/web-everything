/** Pure SHIP-TMO evaluator. Policy values live in settings, never in this module. */
import { resolveCascade } from './policy-cascade.mjs';

export function parseTimeouts(logText) {
  const found = [];
  let test = null;
  for (const raw of String(logText ?? '').split('\n')) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '').replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, '');
    const fail = /^\s*FAIL\s+(\S+)(?:\s+>\s+(.+))?\s*$/.exec(line);
    if (fail) test = /^[\w./@-]+\.test\.[cm]?[jt]sx?$/.test(fail[1]) && !fail[1].includes('..') && fail[2]
      ? { file: fail[1], name: fail[2].trim().replace(/\s+>\s+/g, ' > ').slice(0, 200) } : null;
    const timeout = /\bTest timed out in (\d+)ms\./.exec(line);
    if (timeout && test && Number.isSafeInteger(Number(timeout[1])) && Number(timeout[1]) > 0) {
      found.push({ ...test, runnerLimitMs: Number(timeout[1]), truncated: true });
      test = null;
    }
  }
  return found;
}

export function durationMs(value) {
  const m = typeof value === 'string' && /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!m || !m.slice(1).some(Boolean)) return null;
  const ms = ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 60_000 + Number(m[4] ?? 0) * 1000;
  return Number.isSafeInteger(ms) && ms > 0 ? ms : null;
}

export function resolveLimits(policy, { file, job }) {
  const local = job?.split(' / ').at(-1);
  const scopes = ['all', `jobs.${Object.hasOwn(policy?.jobs ?? {}, job) ? job : local}`, `tests.${file}`];
  const resolved = resolveCascade({ standard: policy?.all, platform: policy?.jobs?.[job] ?? policy?.jobs?.[local], tool: policy?.tests?.[file] });
  const sources = Object.fromEntries(Object.entries(resolved.sources).map(([key, layer]) => [key, {
    policy: policy?.id ?? 'scripts/settings/test-timeout-policy.json', level: policy?.level, scope: scopes[['standard', 'platform', 'tool'].indexOf(layer)],
  }]));
  const value = resolved.value ?? {};
  const soft = durationMs(value.soft), hard = durationMs(value.hard);
  return { ...value, softMs: soft, hardMs: soft !== null && (hard === null || hard <= soft) ? soft : hard, sources };
}

export function classify(measure, limits) {
  const { softMs: soft, hardMs: hard } = limits;
  const duration = measure.durationMs ?? measure.runnerLimitMs;
  let kind = 'within', conformityLoss;
  if ((soft == null && hard == null) || !Number.isSafeInteger(duration) || duration < 0) kind = 'unconfigured';
  else if (measure.truncated) {
    kind = 'hard';
    if (limits.runnerKillAtHard === false && soft !== null && hard > soft && measure.runnerLimitMs === soft) {
      kind = 'soft'; conformityLoss = 'runner-kills-at-soft (G1)';
    }
  } else if (hard !== null && duration > hard) kind = 'hard';
  else if (soft !== null && duration > soft) kind = 'soft';
  else if (soft !== null && limits.headroom > 0 && limits.headroom < 1 && duration >= soft * (1 - limits.headroom)) kind = 'headroom';
  const types = { within: [], headroom: ['warning'], soft: ['quarantine', 'alert', 'fix-card'], hard: ['red-main'], unconfigured: ['alert'] };
  return { class: kind, measured: { ...measure, durationMs: duration }, limits, ...(conformityLoss ? { conformityLoss } : {}),
    verdict: { result: ['within', 'headroom'].includes(kind) ? 'pass' : kind === 'hard' ? 'fail' : 'unknown',
      ...(kind === 'soft' ? { reason: 'https://everstandards.dev/ship/test-timeout-policy/v0.1/reasons/soft-timeout' } : kind === 'unconfigured' ? { reason: 'missing' } : {}) },
    outputs: types[kind].map(type => ({ type, ...(type === 'fix-card' ? { priority: 'high' } : {}) })) };
}

/** Require a one-to-one match: an ordinary failure in this job prevents immediate quarantine. */
export function timeoutOutcomes(failures, policy, job) {
  return (failures?.timeouts ?? []).map(t => ({ ...t, ...classify(t, resolveLimits(policy, { file: t.file, job })) }));
}
export function allSoft(failures, outcomes) {
  return failures?.complete === true && failures.tests?.length > 0 && outcomes.length === failures.tests.length
    && failures.tests.every(t => outcomes.filter(o => o.file === t.file && o.name === t.name && o.class === 'soft').length === 1);
}

export function softRecord(entry, { history = [], now, run, head }) {
  const outcomes = entry.timeouts;
  const limits = outcomes[0].limits;
  const id = `timeout:${run}:${entry.job}:${entry.test}`;
  const own = { id, at: now, run, head, outcomes };
  const window = durationMs(limits.escalation?.window);
  const counted = [...history, own].filter(e => Number.isFinite(e.at) && e.at <= now && (window === null || now - e.at <= window));
  const escalated = !Number.isInteger(limits.escalation?.count) || limits.escalation.count <= 0 || window === null || counted.length >= limits.escalation.count;
  const priority = escalated ? 'urgent' : 'high';
  const outputs = ['quarantine', 'alert', 'fix-card', ...(escalated ? ['escalation'] : [])].map(type => ({ type, ref: type === 'quarantine' ? id : `${id}:${type}`, priority,
    ...(type === 'escalation' ? { entries: counted.map(e => e.id) } : {}) }));
  return { ...own, priority, outputs, release: Number.isInteger(limits.release?.passes) && limits.release.passes > 0
    ? { passesUnderSoft: limits.release.passes } : { approvalRequired: true },
  note: 'file-level skip quarantines every case in the file (G2); typed outputs use structured safety-net logs; fileCardPerEntry also records card-owed events' };
}
