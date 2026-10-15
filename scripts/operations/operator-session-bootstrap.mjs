#!/usr/bin/env node
// SEAM — a daemon can later consume the same bootstrapPlan() object instead of a chat session.
import { op } from './registry.mjs';
import { compute } from './step-kinds.mjs';
export function formatBootstrap(plan) {
  return `PR movement sweep cron: ${plan.cron.schedule}\n${plan.cron.prompt}\n\nMonitor command:\n${plan.monitorCommand}\n\nUnacknowledged items:\n${plan.unacknowledged.map(i => JSON.stringify(i)).join('\n') || '(none)'}\n\nAcknowledge after reading:\n${plan.ackCommand}`;
}
export function operatorSessionBootstrapOperation({ collect } = {}) {
  if (typeof collect !== 'function') throw new TypeError('operator-session-bootstrap needs a collect reader');
  return op('operator-session-bootstrap', { input: {}, verdictFrom: 'plan', plan: compute({ reads: [], fn: () => collect() }) });
}
export function finishBootstrap({ run, code, lines, json = false }) {
  return json || !run?.verdict ? { code, lines } : { code, lines: [formatBootstrap(run.verdict)] };
}
