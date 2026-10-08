/**
 * @file scripts/lib/codeql-gate.mjs — the CodeQL drain-gate facts, shared by the drain and the repair owner
 * (card x8cnbii).
 *
 * The drain (`merge-ai-prs.mjs`, `drainBlocksOnCodeQL`, PR #4245) refuses to land a PR whose latest `CodeQL`
 * check concluded FAILURE. CodeQL is not a required check, so nothing in the conveyor owned that repair: PR #4370
 * sat `ready-to-merge` + `review:accepted` and was skipped every pass with nobody working it (2026-10-08). This
 * module is the one place that says "the drain holds this PR for CodeQL" and reads WHAT the alert is, so the
 * fix daemon can own the repair with the alert in the brief.
 *
 * The app token cannot read the code-scanning alerts API, so the alert is read from the CodeQL check-run's
 * ANNOTATIONS (`gh api repos/<repo>/check-runs/<id>/annotations`), which carry the rule title, file, line and
 * message. Pure except {@link readCodeQLAlerts}, whose `exec` is injected.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collapseRollupToLatestPerName } from './rollup-collapse.mjs';

export const CODEQL_CHECK_NAME = 'CodeQL';

/**
 * The drain-gate knob (`scripts/drain-gate-settings.json`, default ON, malformed/missing falls back to ON).
 * Moved here from `merge-ai-prs.mjs`, which re-exports it unchanged.
 */
export function loadDrainGateSettings(path = join(dirname(fileURLToPath(import.meta.url)), '..', 'drain-gate-settings.json')) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return { drainBlocksOnCodeQL: raw?.drainBlocksOnCodeQL !== false };
  } catch { return { drainBlocksOnCodeQL: true }; }
}

/** The newest `CodeQL` rollup row whose conclusion is FAILURE, or `null` (absent, pending and passing are all null). */
export function failedCodeQLCheck(pr) {
  if (pr?.requiredCheckReadError) return null;
  const roll = Array.isArray(pr?.statusCheckRollup) ? pr.statusCheckRollup : [];
  const latest = collapseRollupToLatestPerName(roll).find((c) => (c?.name || c?.context) === CODEQL_CHECK_NAME);
  if (!latest) return null;
  return String(latest.conclusion || latest.state || '').toUpperCase() === 'FAILURE' ? latest : null;
}

/** The numeric check-run id out of a CheckRun `detailsUrl` (`https://github.com/<o>/<r>/runs/<id>`), or `null`. */
export function checkRunIdFromUrl(url) {
  const m = /^https?:\/\/[^/]+\/[^/]+\/[^/]+\/runs\/(\d+)(?:[/?#]|$)/.exec(String(url ?? ''));
  return m ? m[1] : null;
}

/**
 * Reduce raw check-run annotations to alerts. Only `failure`-level annotations are alerts (CodeQL emits `warning`
 * / `notice` for lower severities, which do not fail the check). `rule` is the annotation `title` (the CodeQL
 * query name); the annotations API carries no rule id.
 * @returns {Array<{rule:string, path:string, line:number|null, message:string}>}
 */
export function alertsFromAnnotations(annotations) {
  return (Array.isArray(annotations) ? annotations : [])
    .filter((a) => String(a?.annotation_level ?? '').toLowerCase() === 'failure')
    .map((a) => ({
      rule: String(a.title ?? '').trim() || '(untitled CodeQL alert)',
      path: String(a.path ?? ''),
      line: Number.isFinite(Number(a.start_line)) ? Number(a.start_line) : null,
      message: String(a.message ?? '').trim(),
    }));
}

/**
 * IO: read the failed CodeQL check's annotations. Never throws; a read failure is carried as `readError` so the
 * PR is STILL owed a heal (the agent is told to read the annotations itself).
 * @param {{repo:string, checkRunId:string, exec:Function}} o `exec(file, args)` returns stdout
 */
export function readCodeQLAlerts({ repo, checkRunId, exec }) {
  try {
    const out = exec('gh', ['api', `repos/${repo}/check-runs/${checkRunId}/annotations?per_page=100`]);
    return { alerts: alertsFromAnnotations(JSON.parse(String(out) || '[]')) };
  } catch (e) {
    return { alerts: [], readError: String(e?.message ?? e).split('\n')[0] };
  }
}

/** The reconcile evidence for one PR the drain holds for CodeQL, or `null` when the drain is not holding it. */
export function codeqlFailureEvidence(pr, { repo, exec, settings = loadDrainGateSettings() } = {}) {
  if (!settings.drainBlocksOnCodeQL) return null;
  const check = failedCodeQLCheck(pr);
  if (!check) return null;
  const checkRunId = checkRunIdFromUrl(check.detailsUrl);
  const read = checkRunId && repo && exec ? readCodeQLAlerts({ repo, checkRunId, exec })
    : { alerts: [], readError: 'CodeQL check-run id unreadable from the rollup' };
  return { checkRunId, headSha: pr?.headRefOid ?? null, ...read };
}

/** The brief section appended to the ci-heal prompt for a CodeQL-held PR. */
export function codeqlBriefSection(codeql, { repo = '<repo>', pr = '<pr>' } = {}) {
  const alerts = Array.isArray(codeql?.alerts) ? codeql.alerts : [];
  const list = alerts.length
    ? alerts.map((a) => `- rule: ${a.rule}\n  file: ${a.path}\n  line: ${a.line ?? '?'}\n  message: ${a.message}`).join('\n')
    : `- (the annotations could not be read${codeql?.readError ? `: ${codeql.readError}` : ''}; read them yourself)`;
  return [
    '## THIS HEAL IS FOR A CODEQL ALERT (reason `codeql`) — read before step 3',
    '',
    `The drain refuses to land PR #${pr} because its \`CodeQL\` check FAILED (new code-scanning alerts in the changed code; \`drainBlocksOnCodeQL\`). CodeQL is not a required check, so "every required check is green" does NOT mean there is nothing to heal here: the CodeQL alert IS the CI break. Do not stand down as "not a CI break".`,
    '',
    'The alert(s), from the CodeQL check-run annotations:',
    list,
    '',
    `Re-read them any time: \`gh api repos/${repo}/check-runs/${codeql?.checkRunId ?? '<check-run-id>'}/annotations\` (the app token cannot read the code-scanning alerts API).`,
    '',
    'Fix the flagged code itself so the alert goes away on re-scan (a real sanitization / escaping fix, not a suppression comment and not a weakened guard). Add or extend a test that is red on the old code. Never weaken the CodeQL gate or its settings.',
  ].join('\n');
}
