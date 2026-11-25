/** A filed re-waiver request (rewaive-plan --file-request) admits nothing: only an approved waiver does. */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');

export async function exercise(root) {
  const violations = [];
  const gate = await import(pathToFileURL(join(root, 'scripts/operations/canonical-audit-gate.mjs')).href);
  const { QUESTION_HASH } = await import(pathToFileURL(join(root, 'scripts/operations/codex-audit.mjs')).href);
  const sha = 'a'.repeat(40), ref = 'lane/rewaive';
  const weak = { head: sha, base: 'b'.repeat(40), questionHash: QUESTION_HASH, at: '2026-11-24T10:00:00Z', verdict: 'WEAKENED', findings: ['x.mjs:1 weak'] };
  // The filed request line sits in waiver-requests.jsonl; no approval, so the ops store stays empty.
  const request = JSON.stringify({ ref, sha, ruling: 'R1085', findings: weak.findings, reason: 'ci-heal re-waiver; supersedes ' + 'c'.repeat(40) });
  const home = '/soak-home';
  const readFile = path => {
    if (path === `${home}/workspace/.operations/handoff/waiver-requests.jsonl`) return `${request}\n`;
    if (path === `${home}/audit.jsonl`) return JSON.stringify(weak);
    if (path.endsWith('prototype-load.json')) return JSON.stringify({ auditRecordPath: '~/audit.jsonl' });
    if (path === '/soak-prefs') return JSON.stringify({ prototypeLoad: {} });
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  };
  const result = gate.checkCanonicalAuditForOpen({ repo: '/repo', ref, sha, readFile, fetchMain: () => {}, ancestor: () => true,
    liveFingerprint: () => null, warn: () => {}, env: { HOME: home, WE_PLATFORM_PREFERENCES_FILE: '/soak-prefs' },
    exec: () => sha });
  if (result.ok) violations.push('an unapproved filed request admitted the head');
  return { violations };
}

export default {
  id: 'rewaive-request-never-admits',
  title: 'a filed re-waiver request without an approval never admits the head',
  card: 'DELTA-AUDIT v2',
  fixedBy: { sha: 'HEAD', where: 'working tree', paths: ['scripts/operations/rewaive-plan.mjs'] },
  fixPresent(root) { return existsSync(join(root, 'scripts/operations/rewaive-plan.mjs')); },
  async run({ sourceRoot = ROOT } = {}) { return exercise(sourceRoot); },
  judge: report => report.violations,
};
