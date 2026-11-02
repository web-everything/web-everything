/** Read-only enqueue timing observations. Nothing returned here grants enqueue permission. */
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';

const keyOf = ({ repo, num, headSha }) => `${repo}#${num}@${headSha}`;

/** Completed timings only; pending rows still contribute missed passes and reasons. P90 is nearest-rank. */
export function summarize(lines) {
  const deltas = lines.filter(row => row.actualEnqueueAt != null && Number.isFinite(row.deltaMs))
    .map(row => row.deltaMs).sort((a, b) => a - b);
  const n = deltas.length;
  const reasons = new Map();
  let readyNotReached = 0;
  for (const row of lines) {
    readyNotReached += row.readyNotReached ?? 0;
    for (const [reason, count] of Object.entries(row.reasons ?? {})) {
      reasons.set(reason, (reasons.get(reason) ?? 0) + count);
    }
  }
  return {
    n,
    medianDeltaMs: n ? (deltas[Math.floor((n - 1) / 2)] + deltas[Math.floor(n / 2)]) / 2 : null,
    p90DeltaMs: n ? deltas[Math.ceil(n * 0.9) - 1] : null,
    readyNotReached,
    reasons: Object.fromEntries(reasons),
  };
}

export function createAsyncShadow({
  env = process.env,
  mode = env.WE_ASYNC_DRAIN || 'off',
  dir = join(resolveCoordinationRoot({ env }), 'drain-async-shadow'),
  now = Date.now,
  maxBytes = 1_000_000,
  retentionMs = 24 * 60 * 60_000,
  summaryEvery,
} = {}) {
  if (mode !== 'shadow') {
    const noop = () => {};
    return { observePass: noop, noteSkipReason: noop, recordActual: noop, emitSummary: noop };
  }
  // R425: measurement is opt-in; no mode can change admission or enqueue decisions.
  const records = new Map();
  const completed = new Set();
  let pass = 0;
  // Retained timing logs also prevent replay of already-recorded heads across instances.
  for (const name of ['shadow.jsonl.1', 'shadow.jsonl']) {
    try {
      for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
        try {
          const row = JSON.parse(line);
          if (!row.repo || row.num == null || !row.headSha || row.actualEnqueueAt == null) continue;
          const key = keyOf(row);
          completed.add(key);
          records.set(key, { ...row, readyNotReached: 0, reasons: {} });
        } catch { /* Ignore incomplete or corrupt measurement lines. */ }
      }
    } catch { /* No readable retained log. */ }
  }
  const statePath = join(dir, 'state.json');
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    if (state.version === 1 && Array.isArray(state.records)) {
      for (const row of state.records) {
        if (!row?.repo || row.num == null || !row.headSha
            || !Number.isFinite(row.readyAt) || !Number.isFinite(row.wouldEnqueueAt)) continue;
        const key = keyOf(row);
        // Timing logs win over a snapshot left pending by an interrupted recordActual.
        // Completed metadata is retained only while its timing remains in the rotated logs.
        if (row.actualEnqueueAt != null && !completed.has(key)) continue;
        records.set(key, {
          ...row, ...(completed.has(key) ? records.get(key) : {}),
          readyNotReached: Number.isInteger(row.readyNotReached) && row.readyNotReached >= 0 ? row.readyNotReached : 0,
          reasons: Object.fromEntries(Object.entries(row.reasons ?? {}).filter(([, count]) => Number.isInteger(count) && count >= 0)),
        });
      }
    }
  } catch { /* Missing or corrupt telemetry state never affects the drain. */ }
  const persist = () => {
    const temporary = `${statePath}.${process.pid}.tmp`;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(temporary, JSON.stringify({ version: 1, records: [...records.values()] }));
      renameSync(temporary, statePath);
    } catch { /* Pending observations are best-effort, just like timing logs. */ }
    finally { try { unlinkSync(temporary); } catch { /* Renamed or unavailable. */ } }
  };
  const append = (name, row) => {
    try {
      mkdirSync(dir, { recursive: true });
      const path = join(dir, name);
      let size = 0;
      try { size = statSync(path).size; } catch (error) { if (error.code !== 'ENOENT') return; }
      if (size >= maxBytes) renameSync(path, `${path}.1`);
      appendFileSync(path, `${JSON.stringify(row)}\n`);
    } catch { /* Measurement must never interrupt the drain. */ }
  };
  const emitSummary = () => {
    const summary = summarize([...records.values()]);
    append('summary.jsonl', summary);
    return summary;
  };
  return {
    observePass({ candidates, enqueuedKeys = new Set(), countMissed = true }) {
      pass++;
      const seenAt = now();
      const candidateKeys = new Set(candidates.map(keyOf));
      for (const [key, row] of records) {
        // Freeze superseded, closed/merged, absent and expired heads BEFORE counting this pass.
        if (row.retired) {
          if (!candidateKeys.has(key) && seenAt - row.retiredAt >= retentionMs) records.delete(key);
          continue;
        }
        if (row.actualEnqueueAt != null) continue;
        if (!candidateKeys.has(key) || seenAt - row.wouldEnqueueAt >= retentionMs) {
          row.retired = true;
          row.retiredAt = seenAt;
          continue;
        }
        if (countMissed && !enqueuedKeys.has(key)) row.readyNotReached++;
      }
      for (const candidate of candidates) {
        const key = keyOf(candidate);
        if (records.has(key)) continue;
        const readyAt = candidate.readyAtMs ?? seenAt;
        records.set(key, {
          repo: candidate.repo, num: candidate.num, headSha: candidate.headSha,
          readyAt, wouldEnqueueAt: Math.max(readyAt, seenAt), actualEnqueueAt: null,
          readyNotReached: 0, reasons: {},
        });
      }
      persist();
      // Optional cadence is in observed passes; callers may also emit explicitly at pass end.
      if (Number.isInteger(summaryEvery) && summaryEvery > 0 && pass % summaryEvery === 0) emitSummary();
    },
    noteSkipReason(key, reason) {
      const row = records.get(key);
      if (!row || row.retired || row.actualEnqueueAt != null) return;
      Object.defineProperty(row.reasons, reason, { value: (Object.hasOwn(row.reasons, reason) ? row.reasons[reason] : 0) + 1, enumerable: true, configurable: true });
      persist();
    },
    recordActual(candidate) {
      const key = keyOf(candidate);
      const row = records.get(key);
      if (!row || row.retired || completed.has(key)) return;
      row.actualEnqueueAt = now();
      row.deltaMs = row.actualEnqueueAt - row.wouldEnqueueAt;
      completed.add(key);
      const { repo, num, headSha, readyAt, wouldEnqueueAt, actualEnqueueAt, deltaMs } = row;
      append('shadow.jsonl', { repo, num, headSha, readyAt, wouldEnqueueAt, actualEnqueueAt, deltaMs });
      persist();
    },
    emitSummary,
  };
}
