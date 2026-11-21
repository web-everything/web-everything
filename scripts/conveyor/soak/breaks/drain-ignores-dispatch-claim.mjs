/** The drain merged a PR while a live ci-heal dispatch claim held it: the fresh re-read only read `fixing` claims, and a drain-claim shape (no top-level meta.who) was dropped. */
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const PROBE = `
const [drainUrl, procUrl, claimUrl] = process.argv.slice(1);
const { mkdtempSync, rmSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
const drain = await import(drainUrl); const proc = await import(procUrl); const claims = await import(claimUrl);
const lockRoot = mkdtempSync(join(tmpdir(), 'soak-drain-claim-'));
try {
  const NOW = Date.parse('2026-11-21T08:09:00Z');
  const got = claims.acquireFixDispatchClaim({ repo: 'we', pr: 7283, kind: 'ci-heal', owner: 'studio:14073', nowMs: NOW, lockRoot });
  // A tree without the factory falls back to the reader the drain used before: it must be seen to merge.
  const readClaim = drain.drainClaimReaderFor
    ? drain.drainClaimReaderFor('on', { drain: a => proc.readLiveDrainClaim({ ...a, lockRoot, nowMs: NOW }) })
    : a => proc.readLiveFixClaim({ ...a, lockRoot, nowMs: NOW });
  const pr = { number: 7283, title: 'Claim soak', body: 'A complete change description', baseRefName: 'main', headRefName: 'lane/x',
    headRefOid: 'a'.repeat(40), mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', labels: [{ name: 'ready-to-merge' }],
    statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] };
  const verdict = drain.classifyPr(drain.attachLiveFixClaim(pr, { claimKey: 'we', readClaim }), { defaultBranch: 'main', blockOnCodeQL: false });
  process.stdout.write(JSON.stringify({ acquired: got.ok, decision: verdict.decision, reason: verdict.reason }));
} finally { rmSync(lockRoot, { recursive: true, force: true }); }`;

function probe(root) {
  const urls = ['scripts/merge-ai-prs.mjs', 'scripts/conveyor/fix-procedure.mjs', 'scripts/conveyor/fix-dispatch-claim.mjs']
    .map(p => pathToFileURL(join(root, p)).href);
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', PROBE, ...urls], { encoding: 'utf8' }));
}

export default {
  id: 'drain-ignores-dispatch-claim',
  title: 'with honourDispatchClaims=on a live ci-heal dispatch claim refuses the drain merge as claim-held',
  card: 'async-fixer S6a-2: the drain honours dispatch claims on the direct-merge path',
  fixedBy: { sha: 'lane/async-s6a2-drain-honours-claims', where: 'main' },
  // By behaviour: the held claim must yield a skip, which only the new reader adapter produces.
  fixPresent(root) { try { return probe(root).decision === 'skip'; } catch { return false; } },
  async run({ sourceRoot = ROOT } = {}) {
    try {
      const out = probe(sourceRoot);
      const violations = [];
      if (!out.acquired) violations.push('fixture claim was not acquired');
      if (out.decision !== 'skip') violations.push(`drain would merge past a live ci-heal claim: ${JSON.stringify(out)}`);
      else if (!/claim-held|claim on/.test(out.reason ?? '')) violations.push(`skip is not a claim-held refusal: ${out.reason}`);
      return { violations };
    } catch (error) { return { violations: [error.message] }; }
  },
  judge: report => report.violations,
};
