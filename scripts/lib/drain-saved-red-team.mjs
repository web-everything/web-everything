import { verifySavedRedTeamProvenance } from './saved-red-team-provenance.mjs';
/** Completed evidence survives a withheld/failed comment. Readers must scrub saved text before publication. */
import { resolveScorecardStorePath } from '../conveyor/run-scorecard-store.mjs';
import { scorecardOperationSnapshot } from './scorecard-operation-snapshot.mjs';
import { cascadePolicy, formatCascadeSourcesLine, platformPreference } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';

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
export const sameRepo = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/**
 * The lazy saved-result fallback every comment-only reader of the gate's decision shares (the drain hold, RULING
 * NEEDED, `operator-why`, the clear-human ruling): asked only when the thread has no live-head result. Throws on
 * unreadable evidence; each caller decides how to surface that.
 */
export function savedRedTeamFallback({ repo, pr, head, env = process.env, runsDir, log } = {}) {
  return () => readSavedRedTeamResult({ repo, pr, head: String(head ?? '').toLowerCase(), env, runsDir, log });
}

export function readSavedRedTeamResult({ repo, pr, head, env = process.env, runsDir, scorecardSnapshot,
  log = line => process.stderr.write(`${line}\n`) } = {}) {
  if (!repo || !Number.isSafeInteger(Number(pr)) || Number(pr) <= 0 || !/^[a-f0-9]{40}$/.test(head ?? '')) return null;
  if (!readSavedRedTeamSetting({ env }).value.drainReadsSavedResult) return null;
  const ignore = reason => { log(`saved-red-team-ignored: ${reason}`); return null; };
  const path = resolveScorecardStorePath(env);
  // The calling operation's one scorecard read when it handed one over for this same path (xwu9oxh S2), else a
  // fresh read of our own. Either way this check applies its own refusals to that read's outcome.
  const snapshot = scorecardSnapshot?.path === path ? scorecardSnapshot : scorecardOperationSnapshot(path);
  const read = snapshot.read();
  if (!read.ok) { if (read.error?.code === 'ENOENT') return ignore('saved result store missing'); throw new Error('saved red-team evidence unreadable'); }
  // The shared reader intentionally tolerates corrupt files for accounting. Admission must refuse them,
  // rather than let an empty history trigger the never-scheduled escape. Validate the same snapshot first.
  if ('parseError' in read) throw new Error('saved red-team evidence malformed');
  const store = read.value;
  if (!Array.isArray(store?.records)) throw new Error('saved red-team evidence malformed');
  // A valid store's records: exactly what readStore makes of the same text.
  const records = store.records;
  // Same completed-seat selection as speculateRedTeam/resumeRedTeam, additionally bound to the repo.
  const row = records.filter(r => r?.dispatchKind === 'review-seat' && r.seat === 'red-team'
    && sameRepo(r.repo, repo) && r.pr === Number(pr) && r.rev === head && r.status === 'ok').at(-1);
  if (!row) return ignore('no matching completed saved result');
  const ignored = verifySavedRedTeamProvenance({ repo, pr, head, path, records, index: records.indexOf(row), env, runsDir });
  if (ignored) return ignore(ignored);
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


/** The gate's reader of a withheld saved result: the identical, fully-checked reader (provenance, setting, completeness). */
export const readSavedRedTeamGateResult = readSavedRedTeamResult;

/**
 * A pass that ran on this head, usable or not (errored, unparseable, not posted). Not a result, but never a
 * "never scheduled" head either: it stays held until a usable result exists.
 */
export function attemptedRedTeamRun(rows, { repo, pr, head }, result) {
  const status = typeof result === 'string' ? result : result?.status;
  return ['ran', 'error'].includes(status) || rows.some(row => row?.dispatchKind === 'review-seat'
    && row.seat === 'red-team' && sameRepo(row.repo, repo) && Number(row.pr) === Number(pr) && String(row.rev ?? '').toLowerCase() === head);
}
