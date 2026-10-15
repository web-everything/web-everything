#!/usr/bin/env node
// SEAM — a daemon can later consume the same bootstrapPlan() object instead of a chat session.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handoffHome } from './handoff-home.mjs';
import { feedPath, monitorCommand, unacknowledged, resolveSettings, logSettings } from './needs-you-feed.mjs';
import { op } from './registry.mjs';
import { compute } from './step-kinds.mjs';
export function bootstrapPlan(options = {}) {
  const settings = resolveSettings(options); logSettings(settings, options.log);
  const path = feedPath(options);
  let rules = '';
  try { rules = readFileSync(join(handoffHome(options), 'handoff-webeverything-rules.md'), 'utf8').split('\n').filter(line => /quiet/i.test(line)).join('\n'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const prompt = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'operator-session/pr-movement-sweep.prompt.md'), 'utf8').trim();
  return { cron: { schedule: '*/30 * * * *', prompt: prompt + (rules ? `\n\nQuiet-hours rules (from handoff rules)\n${rules}` : '') },
    monitorCommand: monitorCommand(path), unacknowledged: unacknowledged({ path }), ackCommand: 'node scripts/operations/needs-you-feed.mjs ack' };
}
export function formatBootstrap(plan) {
  return `PR movement sweep cron: ${plan.cron.schedule}\n${plan.cron.prompt}\n\nMonitor command:\n${plan.monitorCommand}\n\nUnacknowledged items:\n${plan.unacknowledged.map(i => JSON.stringify(i)).join('\n') || '(none)'}\n\nAcknowledge after reading:\n${plan.ackCommand}`;
}
export function operatorSessionBootstrapOperation({ collect = bootstrapPlan } = {}) {
  return op('operator-session-bootstrap', { input: {}, verdictFrom: 'plan', plan: compute({ reads: [], fn: () => collect() }) });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const plan = bootstrapPlan(); console.log(process.argv.includes('--json') ? JSON.stringify(plan, null, 2) : formatBootstrap(plan)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

export function finishBootstrap({ run, code, lines, json = false }) {
  return json || !run?.verdict ? { code, lines } : { code, lines: [formatBootstrap(run.verdict)] };
}
