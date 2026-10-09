/** Card xkuflno — read-only resource facts and the shared policy's per-kind shadow verdicts. */
import { op } from './registry.mjs';
import { compute } from './step-kinds.mjs';
import { decideAdmission, RESOURCE_POLICY_STANDARD } from '../lib/resource-admission.mjs';

export const RESOURCE_STATUS_OP = 'resource-status';

export function assessResourceStatus({ snapshot, policy = RESOURCE_POLICY_STANDARD, sources = {}, nowMs }) {
  const verdicts = Object.fromEntries(Object.keys(policy).filter(kind => kind !== 'staleGraceMs')
    .map(kind => [kind, decideAdmission({ kind, snapshot, policy, nowMs })]));
  const decisions = Object.values(verdicts);
  const freshness = decisions.some(d => d.reason === 'snapshot-missing') ? 'missing'
    : decisions.some(d => d.reason.startsWith('snapshot-stale')) ? 'stale' : 'fresh';
  return { snapshot, policy, sources, nowMs, freshness, snapshotAge: decisions[0]?.snapshotAge ?? null, verdicts };
}

const value = n => Number.isFinite(n) ? String(n) : 'n/a';
function easternTime(iso, includeDate = false) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 'n/a';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(ms).map(p => [p.type, p.value]));
  return `${includeDate ? `${parts.year}-${parts.month}-${parts.day} ` : ''}${parts.hour}:${parts.minute}:${parts.second} ET`;
}

export function renderResourceStatus({ snapshot: s, sources, freshness, snapshotAge, verdicts }) {
  const lines = [freshness === 'missing' ? 'resource snapshot missing (unknown)' :
    `resource snapshot${freshness === 'stale' ? ' stale (unknown)' : ''}  sampled ${easternTime(s.sampledAt, true)} (age ${value(snapshotAge)}s, fresh until ${easternTime(s.freshUntil)})`];
  if (s) {
    lines.push(`  cpu idle ${value(s.cpu?.idlePct)}% (${value(s.cpu?.cores)} cores) · load avg ${(s.cpu?.loadAvg ?? [null, null, null]).map(value).join('/')} (comparison only)`,
      `  memory pressure ${value(s.memory?.pressureLevel)} (${({ 1: 'normal', 2: 'warning', 4: 'critical' })[s.memory?.pressureLevel] ?? 'unknown'}) · disk busy ${value(s.disk?.busyPct)}% (io depth ${value(s.disk?.ioDepth)}, read ${value(s.disk?.readMBps)} MB/s, write ${value(s.disk?.writeMBps)} MB/s)`,
      `  fseventsd cpu ${value(s.fsevents?.fseventsdCpuPct)}% (backlog: ${value(s.fsevents?.backlog)}) · heavy slots ${value(s.heavySlots?.held)}/${value(s.heavySlots?.cap)} · agent sessions ${value(s.agentSessions?.total)} (claude ${value(s.agentSessions?.claude)}, codex ${value(s.agentSessions?.codex)}) · lanes ${value(s.laneCount)}`);
  }
  lines.push('verdicts');
  for (const [kind, decision] of Object.entries(verdicts)) lines.push(`  ${kind.padEnd(18)} ${decision.verdict.padEnd(5)}  ${decision.reason}${decision.unknown ? ' (unknown)' : ''}`);
  lines.push(`policy sources: standard${sources.platform ? `, platform ${sources.platform}` : ''}${sources.tool ? `, tool ${sources.tool}` : ''}`);
  for (const error of sources.errors ?? []) lines.push(`  policy source error: ${error.source} ${error.path}: ${error.error}`);
  return lines.join('\n');
}

export function resourceStatusOperation({ collect } = {}) {
  if (typeof collect !== 'function') throw new TypeError('resource-status needs a collect reader');
  return op(RESOURCE_STATUS_OP, { input: {}, verdictFrom: 'assess',
    read: compute({ reads: [], fn: () => collect() }),
    assess: compute({ reads: ['findings.read'], fn: ({ findings }) => assessResourceStatus(findings.read) }),
  });
}

export function finishResourceStatus({ run, code, lines, json = false }) {
  return json || !run?.verdict ? { code, lines } : { code, lines: [renderResourceStatus(run.verdict)] };
}
