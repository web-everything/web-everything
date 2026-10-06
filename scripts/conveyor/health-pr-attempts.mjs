/** Per-PR attempt evidence for the health watch. No host calls or mutations.
 * Untimestamped log ticks use the watch's existing bootstrap interval estimate.
 * Count outcome lines, never echoed command stderr or aggregate tick counts.
 */
import { stripLogTimestamp } from '../../skills-src/conveyor/daemon-log.mjs';

export const ATTEMPT_WINDOW_MS = 60 * 60_000;
export const MIN_PR_ATTEMPTS = 5;
const BENIGN = /^(?:live-process|nothing-owed|no-findings|stood-down|load-flake-hold|owed-elsewhere|held|main-still-red)$/;

/** Recorded no-op decisions, not a blanket exemption for a PR's labels. A human
 * gate can still owe an advisory review/fix on a newer head. Keep failures of that
 * work, including missing-run-cap-exhausted, even while the human gate remains.
 * Also applied at evaluation time to clean episodes backed by pre-upgrade memory.
 */
export function isExpectedPrWait(row) {
  if (row.outcome === 'failed' || row.source === 'record') return false;
  const reason = String(row.reason ?? '');
  if (/^(?:draft|fix-claimed|concurrent-author-paused|already-reviewed-head): /.test(reason)) return true;
  if (/^cap-exhausted: .*a person must take it/.test(reason)) return true;
  if (/^ci-heal-escalated: .*already (?:escalated|confirmed) this exact head/.test(reason)) return true;
  if (/^human-gated: .*review:human/.test(reason)) return true;
  return /^scope-overlap: .* — waiting \d+(?:st|nd|rd|th) behind #\d+(?:, #\d+)* on \S+ — serializing, retrying next pass$/.test(reason);
}

export function attemptAction(text, fallback = '') {
  if (/missing-run/.test(text)) return 'missing-run-recovery';
  if (/open-pr/.test(text)) return 'open-pr';
  if (/conflict/.test(text)) return 'conflict-fix';
  if (/ci-heal|hung-ci/.test(text)) return 'ci-heal';
  if (/review/.test(text)) return 'review-dispatch';
  if (/fix/.test(text)) return 'fix-dispatch';
  return fallback;
}

export function foldPrAttempts(previous, sample, now, intervalMs) {
  const lines = String(sample.text ?? '').split('\n').map(stripLogTimestamp);
  const tickCount = lines.filter((l) => /^[\w.-]+: tick \(/.test(l)).length;
  let tick = -1;
  const rows = [];
  for (const line of lines) {
    if (/^[\w.-]+: tick \(/.test(line)) { tick++; continue; }
    let m = /^([\w.-]+): (\S+\/\S+)#(\d+) failed \(non-fatal\): (.*)$/.exec(line);
    let repo, pr, reason, action, outcome;
    if (m) {
      [, , repo, pr, reason] = m;
      outcome = 'failed';
      action = attemptAction(reason, attemptAction(m[1]));
    } else if ((m = /^([\w.-]+): (?:refused|reconcile-refused) ([\w-]+) (\S+\/\S+) PR #(\d+) — (.*)$/.exec(line))) {
      if (BENIGN.test(m[2])) continue;
      repo = m[3]; pr = m[4]; reason = `${m[2]}: ${m[5]}`;
      action = attemptAction(reason, attemptAction(m[1]));
    } else if ((m = /^[\w.-]+: ([\w-]+) (\S+\/\S+) PR #(\d+) .*?— (.*)$/.exec(line))) {
      action = attemptAction(`${m[1]} ${m[4]}`);
      if (!action || !/FAILED|applied|retry|refused/.test(m[4])) continue;
      repo = m[2]; pr = m[3]; reason = m[4];
    } else continue;
    if (!action) continue;
    const at = sample.bootstrap
      ? Math.min(now, sample.mtimeMs) - (tickCount - 1 - tick) * intervalMs
      : Math.min(now, sample.mtimeMs);
    const row = { pr: `${repo}#${pr}`, action, reason: reason.slice(0, 600), at, estimated: !!sample.bootstrap,
      ...(outcome ? { outcome } : {}) };
    if (!isExpectedPrWait(row)) rows.push(row);
  }
  return [...(sample.bootstrap ? [] : previous ?? []), ...rows].filter((r) => r.at > now - ATTEMPT_WINDOW_MS && r.at <= now);
}

/** One observable attempt per effect: lifetime attempt counters have no windowed timestamps.
 * Stable keys dedupe copies of records; repeated reads never accumulate observations.
 */
export function recordPrAttempts(records, now) {
  const rows = new Map();
  for (const run of records ?? []) {
    const input = run.input ?? {};
    for (const e of run.effects ?? []) {
      const payload = e.payload ?? {};
      const pr = input.pr ?? input.prNumber ?? payload.pr ?? payload.prNumber;
      const repo = input.repo ?? payload.repo;
      const action = attemptAction(`${run.op} ${payload.launchKind ?? ''}`);
      const at = Date.parse(e.lastAttemptAt ?? e.startedAt ?? '');
      if (!repo || !/^\d+$/.test(String(pr)) || !action || !(at > now - ATTEMPT_WINDOW_MS && at <= now)) continue;
      if (e.status !== 'failed' && !e.error && !(e.attempts > 1) && !['ci-heal', 'conflict-fix', 'missing-run-recovery'].includes(action)) continue;
      const id = `${run.id}:${e.key}`;
      rows.set(id, { pr: `${repo}#${pr}`, action, at, reason: String(e.error ?? `${action} retry`).slice(0, 600), source: 'record' });
    }
  }
  return [...rows.values()];
}
