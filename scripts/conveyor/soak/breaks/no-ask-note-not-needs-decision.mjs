/** Persisted informational notes must not become open operator decisions. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');

export default {
  id: 'no-ask-note-not-needs-decision',
  title: 'legacy no-ask notes stay informational while real decision requests remain open',
  card: 'soak-replay-gate',
  fixedBy: { sha: 'pending', where: 'main', paths: [
    'scripts/lib/pr-comment-policy.mjs', 'scripts/operations/pr-sweep-core.mjs',
  ] },
  fixPresent(root) {
    try {
      return readFileSync(join(root, 'scripts/lib/pr-comment-policy.mjs'), 'utf8').includes('NO_ASK_NOTE_KINDS')
        && readFileSync(join(root, 'scripts/operations/pr-sweep-core.mjs'), 'utf8').includes('NO_ASK_NOTE_KINDS');
    } catch {
      return false;
    }
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || ROOT;
    const { needsDecisionOpen } = await import(pathToFileURL(join(root, 'scripts/operations/pr-sweep-core.mjs')).href);
    const comment = headline => ({
      author: { login: 'web-everything' },
      createdAt: '2026-11-09T12:00:00Z',
      body: `🔔 conveyor — needs your decision\n\nneeds your decision: ${headline}`,
    });
    const violations = [];
    if (needsDecisionOpen([comment('referral-hold-auto-resolved')]) !== null) {
      violations.push('legacy referral-hold-auto-resolved note opens an operator decision');
    }
    const realAsk = comment('fix attempts exhausted');
    const decision = needsDecisionOpen([realAsk]);
    if (!decision || decision.text !== 'needs your decision: fix attempts exhausted') {
      violations.push('real fix attempts exhausted decision request is not returned');
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
