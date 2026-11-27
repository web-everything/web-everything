#!/usr/bin/env node
/** Read-only deployment gate. Input must be captured GitHub label events, timestamped
 * daemon logs and host samples from the same live run; synthetic input is only unit evidence. */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkReviewFastLatency({ labels, logLines, loadSamples } = {}) {
  const errors = [], latencies = [], seen = new Set();
  if (!Array.isArray(labels) || labels.length !== 10 || !Array.isArray(logLines) || !Array.isArray(loadSamples)) {
    return { ok: false, errors: ['need ten label events, daemon log lines and host load samples'] };
  }
  const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT.*Z$/.test(value) ? Date.parse(value) : NaN;
  const dispatches = logLines.flatMap(line => {
    const hit = typeof line === 'string' && /^(\S+) review-fast-pass: ([\w.-]+\/[\w.-]+)#(\d+) dispatched$/.exec(line);
    return hit ? [{ at: timestamp(hit[1]), subject: `${hit[2]}#${Number(hit[3])}` }] : [];
  });
  const loads = loadSamples.map(row => ({ at: timestamp(row?.at), value: row?.loadPerCore }));
  if (loads.some(row => !Number.isFinite(row.at) || !Number.isFinite(row.value) || row.value < 0)) errors.push('malformed host sample');
  for (const event of labels) {
    const subject = `${event?.repo}#${event?.pr}`, start = timestamp(event?.createdAt);
    if (!/^[\w.-]+\/[\w.-]+$/.test(event?.repo ?? '') || !Number.isSafeInteger(event?.pr) || event.pr < 1
      || event.label !== 'review:pending' || !Number.isFinite(start) || seen.has(subject)) {
      errors.push(`invalid or duplicate pending label event: ${subject}`); continue;
    }
    seen.add(subject);
    const stop = dispatches.filter(row => row.subject === subject && row.at >= start).sort((a, b) => a.at - b.at)[0]?.at;
    if (!Number.isFinite(stop)) { errors.push(`missing dispatch log: ${subject}`); continue; }
    latencies.push({ subject, labelAt: event.createdAt, dispatchAt: new Date(stop).toISOString(), ms: stop - start });
    const samples = loads.filter(row => row.at >= start && row.at <= stop).sort((a, b) => a.at - b.at);
    const points = [start, ...samples.map(row => row.at), stop];
    if (!samples.length || samples.some(row => row.value < 0.4)
      || points.some((at, i) => i > 0 && at - points[i - 1] > 15000)) errors.push(`load evidence missing, light or gapped: ${subject}`);
  }
  const sorted = latencies.map(row => row.ms).sort((a, b) => a - b);
  const maxMs = sorted.at(-1) ?? null, medianMs = sorted.length === 10 ? (sorted[4] + sorted[5]) / 2 : null;
  if (sorted.length !== 10 || maxMs > 180000 || medianMs === null || medianMs >= 180000) errors.push('latency acceptance failed');
  return { ok: errors.length === 0, maxMs, medianMs, latencies, errors };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const path = process.argv[2];
    if (!path || statSync(path).size > 1024 * 1024) throw Error('supply an evidence JSON file of at most 1 MiB');
    const result = checkReviewFastLatency(JSON.parse(readFileSync(path, 'utf8')));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`review-fast-pass acceptance: ${String(error.message).replace(/[\x00-\x1f\x7f]/g, ' ')}\n`);
    process.exitCode = 1;
  }
}
