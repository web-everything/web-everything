/**
 * Operator approval record bound to the exact head sha (CORE-AUTH-003/004, AUTH-BOUND-APPROVAL).
 *
 * Replaces the forgeable `Operator-pre-approved: R<id>` PR body line. The record is a check run named
 * {@link APPROVAL_CHECK_NAME} on the head commit, `external_id = <ruling>@<40-hex head>`, written ONLY by the WE
 * App (checked by app id, never by name). A new push changes the head, so the record no longer matches and the
 * approval is void until re-written. Every parse or read error refuses. The newest check-run id decides.
 * Guard-config confinement is re-derived from the diff by the caller, never read from the record.
 */
import { runGhSync } from './gh-throttle.mjs';
import { redTeamWriterEnv, requireRedTeamAppWriter, resolveWeAppId } from './red-team-check-run.mjs';

export const APPROVAL_CHECK_NAME = 'operator-approval';
/** The trust root, pinned in code under a protected path (REVIEW_AUTH_FLOOR): the WE App id that may author an
 *  approval record, and the operator logins that may ask for one. A setting, env or argument can only NARROW these
 *  (a different value refuses); nothing local can widen or replace them. Changing either is a reviewed code change. */
export const PINNED_APP_ID = '5037855';
export const OPERATOR_LOGINS = Object.freeze(['chalbert']);
const ioOptions = { encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] };
const validHead = head => typeof head === 'string' && /^[a-f0-9]{40}$/i.test(head);
const validApp = id => /^[1-9]\d*$/.test(String(id ?? '')) && Number.isSafeInteger(Number(id));
export const validRulingId = id => typeof id === 'string' && /^R\d+(?:\+R\d+)*$/.test(id);
const failure = reason => ({ ok: false, reason });
const message = error => String(error?.message ?? error).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 300);

export const approvalExternalId = (rulingId, headSha) => `${rulingId}@${String(headSha).toLowerCase()}`;

/** The check-run body the approval tool posts. Pure. */
export function approvalCheckPayload({ headSha, rulingId, approver } = {}) {
  return { name: APPROVAL_CHECK_NAME, head_sha: headSha, external_id: approvalExternalId(rulingId, headSha),
    status: 'completed', conclusion: 'success',
    output: { title: `Operator approval ${rulingId}`, summary: `Approved by ${approver ?? 'unknown'} under ${rulingId} for head ${headSha}` } };
}

/** Decide from a list of check runs whether `headSha` carries a valid approval record. Pure; fails closed. */
export function evaluateApprovalRecord({ headSha, checkRuns, appId } = {}) {
  if (!validApp(appId)) return failure('approval app id unset or invalid');
  if (!validHead(headSha)) return failure('approval head missing or not a full 40-hex sha');
  if (!Array.isArray(checkRuns)) return failure('approval check runs unreadable');
  const head = headSha.toLowerCase();
  const runs = checkRuns.filter(run => run?.name === APPROVAL_CHECK_NAME && Number(run.app?.id) === Number(appId)
    && typeof run.head_sha === 'string' && run.head_sha.toLowerCase() === head);
  if (!runs.length) return failure('no approval record on head');
  if (runs.some(run => !Number.isSafeInteger(run.id) || run.id <= 0) || new Set(runs.map(run => run.id)).size !== runs.length)
    return failure('approval record ordering unreadable');
  runs.sort((a, b) => b.id - a.id);
  const latest = runs[0];
  const match = /^(R\d+(?:\+R\d+)*)@([a-f0-9]{40})$/i.exec(String(latest.external_id ?? ''));
  if (!match) return failure('approval record malformed (ruling id and full head required)');
  if (match[2].toLowerCase() !== head) return failure('approval record is bound to another head');
  if (latest.status !== 'completed' || latest.conclusion !== 'success') return failure('approval record not a completed success');
  return { ok: true, rulingId: match[1], reason: 'approval record bound to head' };
}

/** Read the record for `headSha` live. `recheckHead()` re-reads the current head right after the read; a move refuses. */
export function readApprovalRecord({ repo, headSha, appId, gh = runGhSync, env = process.env, recheckHead, resolveApp = resolveWeAppId } = {}) {
  // The App id is the pinned constant. A caller argument or the local setting may only narrow it: any value that
  // differs refuses. An unreadable setting leaves the pin in force (it can never disable or widen the trust root).
  const id = PINNED_APP_ID;
  if (appId !== undefined && String(appId) !== id) return failure('approval app id differs from the pinned trust root');
  let app = { ok: false };
  try { app = resolveApp({ env: { ...env, WE_APP_ID: undefined } }); } catch { /* the pin stands */ }
  if (app?.ok === true && String(app.appId) !== id) return failure('approval app setting differs from the pinned trust root');
  if (!validHead(headSha)) return failure('approval head missing or not a full 40-hex sha');
  let data;
  try { data = JSON.parse(gh(['api', `repos/${repo}/commits/${headSha}/check-runs?check_name=${APPROVAL_CHECK_NAME}&filter=all&per_page=100`], { ...ioOptions, throttle: { noMemo: true, bin: 'gh' } })); }
  catch (error) { return failure(`approval record unreadable: ${message(error)}`); }
  if (!Array.isArray(data?.check_runs) || !Number.isSafeInteger(data.total_count) || data.total_count !== data.check_runs.length)
    return failure('approval record unreadable or incomplete');
  const fact = evaluateApprovalRecord({ headSha, checkRuns: data.check_runs, appId: id });
  if (fact.ok !== true || typeof recheckHead !== 'function') return fact;
  let now;
  try { now = recheckHead(); } catch (error) { return failure(`head recheck failed: ${message(error)}`); }
  return String(now ?? '').toLowerCase() === headSha.toLowerCase() ? fact : failure('head moved after the approval read');
}

/** Write the record. Verifies the ruling and the App token BEFORE any write; no personal fallback. */
export function writeApprovalRecord({ repo, headSha, rulingId, approver, rulingExists, gh = runGhSync, env = process.env } = {}) {
  if (!validHead(headSha)) return failure('head must be a full 40-hex sha');
  if (!validRulingId(rulingId)) return failure('ruling id must look like R123 or R123+R124');
  if (typeof approver !== 'string' || !approver.trim() || approver.trim().toLowerCase() === 'unknown')
    return failure('operator identity missing; nothing written');
  if (!OPERATOR_LOGINS.includes(approver.trim().toLowerCase())) return failure('login is not in the pinned operator allowlist; nothing written');
  if (typeof rulingExists !== 'function') return failure('no ruling verifier supplied');
  let known = false;
  try { known = rulingId.split('+').every(id => rulingExists(id) === true); } catch { known = false; }
  if (!known) return failure(`unknown ruling ${rulingId}; nothing written`);
  const writer = requireRedTeamAppWriter({ gh, env });
  if (writer.ok !== true) return failure('approver App token unavailable, no personal fallback; nothing written');
  try {
    gh(['api', `repos/${repo}/check-runs`, '--method', 'POST', '--input', '-'],
      { ...ioOptions, input: JSON.stringify(approvalCheckPayload({ headSha, rulingId, approver })), env: redTeamWriterEnv(env) });
    return { ok: true, rulingId, headSha };
  } catch (error) { return failure(`approval write failed: ${message(error)}`); }
}
