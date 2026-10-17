#!/usr/bin/env node
/** Read-only seat timing census. Does not invoke the run-store's migration-on-resolve path. */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFileRunStore, sharedRunsDir } from './run-store.mjs';
import { seatTimingReport } from './review-seat-timing-core.mjs';
export { seatTimingReport } from './review-seat-timing-core.mjs';

export function readSeatTimingReport({ env = process.env, since = null } = {}) {
  const store = createFileRunStore(env.OPERATION_RUNS_DIR?.trim() || sharedRunsDir(env));
  const records = [];
  const unreadableRuns = [];
  for (const id of store.list()) {
    try { records.push(store.read(id)); } catch { unreadableRuns.push(id); }
  }
  return { ...seatTimingReport(records, { since }), unreadableRuns };
}

const seconds = ms => ms === null ? 'n/a' : `${(ms / 1000).toFixed(1)}s`;
export function renderSeatTimingReport(report) {
  return [
    ...report.runs.map(r => `${r.runId} ${r.repo}#${r.pr}: spread ${seconds(r.spreadMs)}, first change-request lead ${seconds(r.firstChangeRequestLeadMs)}${r.complete ? '' : ' (incomplete)'}`),
    `Runs: ${report.summary.completeRuns} complete, ${report.summary.incompleteRuns} incomplete; median spread ${seconds(report.summary.medianSpreadMs)}, p90 ${seconds(report.summary.p90SpreadMs)} (nearest rank).`,
    `First change-request >5 min before last seat: ${report.summary.earlyChangeRequestRuns}/${report.summary.completeRuns} (${report.summary.earlyChangeRequestShare === null ? 'n/a' : `${(100 * report.summary.earlyChangeRequestShare).toFixed(1)}%`}).`,
    ...(report.unreadableRuns?.length ? [`Unreadable records: ${report.unreadableRuns.length}`] : []),
  ].join('\n');
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some(a => a !== '--json' && !a.startsWith('--since='))) throw new Error('Usage: review-seat-timing.mjs [--since=<iso>] [--json]');
    const report = readSeatTimingReport({ since: args.find(a => a.startsWith('--since='))?.slice(8) ?? null });
    process.stdout.write(`${args.includes('--json') ? JSON.stringify(report, null, 2) : renderSeatTimingReport(report)}\n`);
  } catch (e) { process.stderr.write(`${e.message}\n`); process.exitCode = 1; }
}
