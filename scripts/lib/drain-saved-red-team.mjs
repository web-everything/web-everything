/** Completed evidence survives a withheld/failed comment. Readers must scrub saved text before publication. */
import { readFileSync } from 'node:fs';
import { readStore, resolveScorecardStorePath } from '../conveyor/run-scorecard-store.mjs';
import { cascadePolicy, formatCascadeSourcesLine, platformPreference } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';
import { isCardOnlyDiff } from '../ci-card-only.mjs';
import { readRedTeamProbes } from './red-team-gate.mjs';

export function readSavedRedTeamSetting({ env = process.env, tool, platform, log } = {}) {
  const raw = env.WE_RED_TEAM_DRAIN_READS_SAVED_RESULT;
  const value = raw === undefined ? undefined : /^(true|on|1)$/i.test(raw) ? true : /^(false|off|0)$/i.test(raw) ? false : raw;
  const pick = o => o?.drainReadsSavedResult === undefined ? {} : { drainReadsSavedResult: o.drainReadsSavedResult };
  const r = cascadePolicy('redTeam', pick(tool ?? readSettings().redTeam), {
    env, platform: pick(platform ?? platformPreference('redTeam', { env })), standard: { drainReadsSavedResult: true },
    valid: v => typeof v === 'boolean', envValues: { drainReadsSavedResult: value },
  });
  if (log) log(formatCascadeSourcesLine('redTeam', r));
  return r;
}

// GitHub slugs are case-insensitive: an operator's `--repo=` and the review job's slug name the same repo.
const sameRepo = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/**
 * The lazy saved-result fallback every comment-only reader of the gate's decision shares (the drain hold, RULING
 * NEEDED, `operator-why`, the clear-human ruling): asked only when the thread has no live-head result. Throws on
 * unreadable evidence; each caller decides how to surface that.
 */
export function savedRedTeamFallback({ repo, pr, head, env = process.env } = {}) {
  return () => readSavedRedTeamResult({ repo, pr, head: String(head ?? '').toLowerCase(), env });
}

export function readSavedRedTeamResult({ repo, pr, head, env = process.env } = {}) {
  if (!repo || !Number.isSafeInteger(Number(pr)) || Number(pr) <= 0 || !/^[a-f0-9]{40}$/.test(head ?? '')) return null;
  if (!readSavedRedTeamSetting({ env }).value.drainReadsSavedResult) return null;
  const path = resolveScorecardStorePath(env);
  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw new Error('saved red-team evidence unreadable'); }
  // The shared reader intentionally tolerates corrupt files for accounting. Admission must refuse them,
  // rather than let an empty history trigger the never-scheduled escape. Validate the same snapshot first.
  let store;
  try { store = JSON.parse(text); } catch { throw new Error('saved red-team evidence malformed'); }
  if (!Array.isArray(store?.records)) throw new Error('saved red-team evidence malformed');
  const records = readStore({ path, read: () => text, exists: () => true }).records;
  // Same completed-seat selection as speculateRedTeam/resumeRedTeam, additionally bound to the repo.
  const row = records.filter(r => r?.dispatchKind === 'review-seat' && r.seat === 'red-team'
    && sameRepo(r.repo, repo) && r.pr === Number(pr) && r.rev === head && r.status === 'ok').at(-1);
  if (!row) return null;
  if (!Array.isArray(row.findings) || row.findings.some(f => !f || typeof f.confirmedByRecheck !== 'boolean')
    || (row.confirmedMissCount !== undefined && row.confirmedMissCount !== row.findings.filter(f => f.confirmedByRecheck).length))
    throw new Error('saved red-team findings incomplete');
  // Confirmed findings can still route through the gate, but do not prove the rest of the re-check finished.
  return { pr: Number(pr), rev: head, scoredAt: row.scoredAt,
    recheckIncomplete: !['ok', 'not-needed'].includes(row.recheckStatus), findings: row.findings.map((f, i) => ({
    index: i + 1, confirmed: f.confirmedByRecheck, impact: f.impactIfUnfixed ?? null,
    category: f.category ?? null, file: f.file ?? null, line: f.line ?? null,
    summary: f.summary ?? '', scenario: f.failure_scenario ?? null, recheck: f.recheckReason ?? null,
  })) };
}

/** Locate the saved result in the trusted thread without inventing a posted comment or an author.
 * Unknown or inconsistent chronology cannot establish a later operator ruling. */
export function savedRedTeamPosition(result, pr, head, records) {
  const savedAt = Date.parse(result?.scoredAt);
  if (result?.pr !== Number(pr) || result.rev !== head || !Number.isFinite(savedAt)) return null;
  const times = records.map(r => Date.parse(r.c?.createdAt));
  if (times.some((t, i) => !Number.isFinite(t) || (i > 0 && t < times[i - 1]))) return null;
  return { at: records.reduce((at, r, i) => times[i] <= savedAt ? r.at : at, -1) + 0.5 };
}


/** Match the scheduler's net paths, including rename/copy sources; unknown evidence still owes a pass. */
export function skipCardOnlyRedTeam(loopPayload, env = process.env) {
  const read = loopPayload?.findings?.read;
  const files = Array.isArray(read?.netChangedFiles) && read.netChangedFiles.length
    && (read.netRenameSources == null || Array.isArray(read.netRenameSources))
    ? [...read.netChangedFiles, ...(read.netRenameSources ?? [])] : null;
  return readRedTeamProbes({ env }).value.skipCardOnly && isCardOnlyDiff(files);
}

/** A dispatch attempt is not a result. Only posted evidence or a saved parsed live-head verdict counts. */
export function recordedRedTeamResult(rows, { repo, pr, head }, result) {
  return result?.comment === 'posted' || rows.some(row => row?.dispatchKind === 'review-seat'
    && row.seat === 'red-team' && sameRepo(row.repo, repo) && Number(row.pr) === Number(pr) && row.rev === head
    && row.status === 'ok' && ['accept', 'changes'].includes(row.seatVerdict));
}
