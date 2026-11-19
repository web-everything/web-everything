/** A clean main merge shifts hunk offsets and used to void the waiver. */
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { sameContentRepo } from '../../../lib/__tests__/fixtures/same-content-repo.mjs';

export async function probe(root) {
  const f = sameContentRepo('clean');
  try {
    const load = path => import(pathToFileURL(join(root, path)).href);
    const { classifyHeadMove } = await load('scripts/lib/same-content-carry.mjs');
    const { netDiffFingerprint } = await load('scripts/lib/net-diff-fingerprint.mjs');
    const { readyEvidence, canonicalAuditEvidence } = await load('scripts/operations/prototype-load.mjs');
    const { QUESTION_HASH } = await load('scripts/operations/codex-audit.mjs');
    const before = netDiffFingerprint(f.repo, 'origin/main', f.from), after = netDiffFingerprint(f.repo, 'origin/main', f.to);
    const proof = classifyHeadMove(f), violations = [];
    if (!before || !after || before === after) violations.push('fixture did not move the fingerprint');
    if (!proof.carries || proof.commits[0]?.kind !== 'clean-main-merge') violations.push('mechanical merge did not carry');
    const ref = 'lane/soak', findings = ['code.js issue'];
    const ready = readyEvidence([{ ref, sha: f.to, tests: 'green', audit: 'WEAKENED', auditRuling: 'R12', auditDisclosed: findings, fingerprint: before }],
      { branch: ref, sha: f.to }, [{ ref, sha: f.from, ruling: 'R12', findings, fingerprint: before }], after,
      { sameContent: (from, to) => classifyHeadMove({ ...f, from, to }) });
    if (!ready) violations.push('clean merge voided the waiver');
    const audit = { head: f.to, base: f.root, questionHash: QUESTION_HASH, verdict: 'WEAKENED',
      findings, at: '2026-11-01T00:00:00Z' };
    if (!canonicalAuditEvidence([audit], f.to, () => true, after, { ruledWeakened: ready }).ok)
      violations.push('live canonical audit did not admit the exact waiver');
    if (canonicalAuditEvidence([{ ...audit, head: f.from, fingerprint: after }], f.to,
      () => true, after, { ruledWeakened: ready }).ok) violations.push('predecessor audit supplied live evidence');
    return { violations };
  } catch (error) { return { violations: [`same-content proof unavailable: ${error.message}`] }; }
  finally { f.cleanup(); }
}
// Independent presence check: separate repositories, classifier only, and both admission/refusal.
export function probeFixPresence(classify) {
  for (const [kind, carries] of [['clean', true], ['conflict-code', false]]) {
    const f = sameContentRepo(kind);
    try {
      const result = classify({ ...f });
      if (result.carries !== carries || (carries && result.commits[0]?.kind !== 'clean-main-merge')) return false;
    } catch { return false; }
    finally { f.cleanup(); }
  }
  return true;
}
export default {
  id: 'same-content-head-move-voids-carry',
  title: 'A clean merge of main preserves a waiver when hunk offsets shift',
  card: 'same-content carry for waivers',
  fixedBy: { sha: 'same-content-carry', where: 'scripts/lib/same-content-carry.mjs', paths: ['scripts/lib/same-content-carry.mjs'] },
  requiresFix: true,
  fixPresent(root, { classify } = {}) {
    if (classify) return probeFixPresence(classify);
    const script = 'const {probeFixPresence}=await import(process.argv[1]); const {classifyHeadMove}=await import(process.argv[2]); process.stdout.write(String(probeFixPresence(classifyHeadMove)));';
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, import.meta.url, pathToFileURL(join(root, 'scripts/lib/same-content-carry.mjs')).href],
      { env: process.env, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
    return child.status === 0 && child.stdout === 'true';
  },
  run() { return probe(process.env.SOAK_TREE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')); },
  judge(report) { return report.violations; },
};
