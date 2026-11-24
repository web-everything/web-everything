import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GIT_TIMEOUT_MS = 15000;
import { checkCanonicalAuditForOpen } from '../operations/canonical-audit-gate.mjs';

// A path (not `new URL('literal', import.meta.url)`): Vite rewrites that literal form into an asset URL under vitest.
const SETTINGS = join(dirname(fileURLToPath(import.meta.url)), '..', 'settings', 'review-auto-audit.json');
const MODES = new Set(['off', 'shadow', 'on']);
const REQUIRED_LABELS = ['review:human', 'advisory:accepted', 'red-team:clear'];

/** Plan observations only; neither the PR rows nor the caller's seen set is mutated. */
export function planAuditOwed({ repo, rawPrs, check, seen = new Set() }) {
  const owed = [];
  for (const row of Array.isArray(rawPrs) ? rawPrs : []) {
    // The open-PR reader (`gh pr list --state open`, PR_LIST_JSON_FIELDS) has no `state` field: only an explicit non-OPEN state skips.
    if (!row || (row.state != null && String(row.state).toUpperCase() !== 'OPEN') || row.isDraft) continue;
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
    // Every git call is bounded: a stalled fetch must never block the daemon tick (it fails closed to owed-unknown).
    const exec = (cmd, args, opts) => execFileSync(cmd, args, { ...opts, timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL' });
    const result = checkCanonicalAuditForOpen({ repo: repoDir, sha: head, ref: prRow.headRefName, exec });
    return /unreadable|truncated|malformed|fingerprint/i.test(result.message ?? '')
      ? { ...result, unknown: true } : result;
  };
}

/** Invalid or unreadable configuration disables observation; only the shipped file defaults to shadow. */
export function readAutoAuditMode(env = process.env, readFile = readFileSync) {
  try {
    // Nested: every scripts/settings/*.json shares one top-level namespace, so a flat `mode` would collide.
    const settings = JSON.parse(readFile(SETTINGS, 'utf8'))?.reviewAutoAudit;
    if (!settings || typeof settings !== 'object' || !MODES.has(settings.mode)
      || !Number.isSafeInteger(settings.maxPerTick) || settings.maxPerTick <= 0
      || !Number.isSafeInteger(settings.maxAttemptsPerHead) || settings.maxAttemptsPerHead <= 0) return 'off';
    const mode = env.WE_REVIEW_AUTO_AUDIT_MODE ?? settings.mode;
    return MODES.has(mode) ? mode : 'off';
  } catch { return 'off'; }
}
