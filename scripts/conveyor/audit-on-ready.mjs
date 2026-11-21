import { readFileSync } from 'node:fs';
import { checkCanonicalAuditForOpen } from '../operations/canonical-audit-gate.mjs';

const SETTINGS = new URL('../settings/review-auto-audit.json', import.meta.url);
const MODES = new Set(['off', 'shadow', 'on']);
const REQUIRED_LABELS = ['review:human', 'advisory:accepted', 'red-team:clear'];

/** Plan observations only; neither the PR rows nor the caller's seen set is mutated. */
export function planAuditOwed({ repo, rawPrs, check, seen = new Set() }) {
  const owed = [];
  for (const row of Array.isArray(rawPrs) ? rawPrs : []) {
    if (String(row?.state).toUpperCase() !== 'OPEN' || row.isDraft) continue;
    const pr = Number(row.number), head = row.headRefOid;
    if (!Number.isSafeInteger(pr) || pr <= 0
      || typeof head !== 'string' || !/^[a-f0-9]{40}(?![\s\S])/i.test(head)
      || seen.has(`${repo}#${pr}@${head}`)) continue;
    const labels = new Set((Array.isArray(row.labels) ? row.labels : [])
      .map(label => typeof label === 'string' ? label : label?.name));
    if (!REQUIRED_LABELS.every(label => labels.has(label))) continue;
    let result;
    try { result = check(head, row); }
    catch { result = { ok: false, unknown: true }; }
    if (result?.ok === true || (result?.ok === false && result.reason === 'canonical-audit-weakened')) continue;
    owed.push({ repo, pr, head, state: result?.unknown === true || result?.ok !== false ? 'owed-unknown' : 'owed' });
  }
  return owed;
}

export function auditOwedLine({ repo, pr, head }) {
  return `audit-owed ${repo}#${pr} @${head}`;
}

export function defaultAuditCheck({ repoDir }) {
  return (head, prRow) => {
    const result = checkCanonicalAuditForOpen({ repo: repoDir, sha: head, ref: prRow.headRefName });
    return /unreadable|truncated|malformed|fingerprint/i.test(result.message ?? '')
      ? { ...result, unknown: true } : result;
  };
}

/** Invalid or unreadable configuration disables observation; only the shipped file defaults to shadow. */
export function readAutoAuditMode(env = process.env, readFile = readFileSync) {
  try {
    const settings = JSON.parse(readFile(SETTINGS, 'utf8'));
    if (!settings || !MODES.has(settings.mode)
      || !Number.isSafeInteger(settings.maxPerTick) || settings.maxPerTick <= 0
      || !Number.isSafeInteger(settings.maxAttemptsPerHead) || settings.maxAttemptsPerHead <= 0) return 'off';
    const mode = env.WE_REVIEW_AUTO_AUDIT_MODE ?? settings.mode;
    return MODES.has(mode) ? mode : 'off';
  } catch { return 'off'; }
}
