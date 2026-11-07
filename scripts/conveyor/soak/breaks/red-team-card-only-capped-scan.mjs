/** #6507: drain renumbering moved a card head past a capped review-run scan. */
import { mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const EVIDENCE = 'scripts/lib/drain-red-team-evidence.mjs';

export default {
  id: 'red-team-card-only-capped-scan',
  title: 'card-only numbering move remains carry-eligible after a capped run scan',
  card: '#6507; redteam-carry-renumber',
  fixedBy: { sha: 'pending', where: 'lane/redteam-carry-renumber', paths: [EVIDENCE] },
  fixPresent: root => {
    try {
      const source = readFileSync(join(root, EVIDENCE), 'utf8');
      return source.includes('function cappedCardOnlyStatusHead(')
        && source.includes('exactHit.reason === RUN_SCAN_CAPPED.reason')
        && source.includes('lookup: () => ({ ok: true, run: null, at: 0 })')
        && source.includes('read.netBasis?.rev !== oldHead')
        && source.includes('const bounds = exactHit.settleBounds ?? {}')
        && source.includes('const complete = bounds.completeHeadRead({ pr, head, at })');
    } catch { return false; }
  },
  async run({ sourceRoot = ROOT } = {}) {
    const violations = [];
    let scratch;
    try {
      const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
      const { readDrainRedTeamEvidence, recordRedTeamStatus } = await load(EVIDENCE);
      const { cardOnlyHeadMoveCandidate } = await load('scripts/lib/review-red-team-on-skip.mjs');
      const { newRunRecord, writeRun } = await load('scripts/operations/run-store.mjs');
      scratch = mkdtempSync(join(tmpdir(), 'soak-card-only-capped-'));
      // The incident supplied abbreviated SHAs; pad the suffix for head-shape validation.
      const oldHead = 'f74c6542'.padEnd(40, '0'), head = '7431c956'.padEnd(40, '0');
      const runsDir = join(scratch, 'runs');
      const key = { repo: 'web-everything/web-everything', pr: 6507, head, runsDir,
        env: { WE_SHARED_RUNS_DIR: runsDir, WE_RED_TEAM_SKIP_CARD_ONLY: '1' },
        readScorecards: () => [], warn: () => {},
        scanSettings: { file: { runs: { scan: { maxParses: 1 } } }, env: {} } };
      for (let i = 0; i < 4; i++) writeRun(newRunRecord({ id: `review-pr-unrelated-${i}`,
        op: 'review-pr', input: { repo: 'other/repo', pr: i + 1 } }), runsDir);
      const loopPayload = { verdict: { verdict: 'accept' }, findings: { read: {
        netBasis: { rev: oldHead }, netChangedFiles: ['backlog/6507-card.md'], diffText: '+number' } } };
      recordRedTeamStatus({ ...key, loopPayload, status: 'finished',
        result: { status: 'skipped', policy: 'card-only' } }, key);
      const evidence = readDrainRedTeamEvidence(key);
      if (!cardOnlyHeadMoveCandidate(evidence, head)) violations.push('#6507: capped scan stranded the old card-only skip before numbering-move proof');
      if (evidence.status?.head !== oldHead) violations.push('#6507: old-head status was not returned');
      const id = 'review-pr-hidden-running';
      writeRun({ ...newRunRecord({ id, op: 'review-pr', input: { repo: key.repo, pr: key.pr } }),
        findings: { read: { netBasis: { rev: head } } }, pending: { kind: 'read', step: 'read', stepIndex: 0 },
        stepTimings: [{ step: 'read', stepIndex: 0, startedAt: new Date(Date.now() - 10_000).toISOString() }] }, runsDir);
      const recent = new Date(Date.now() - 1000);
      utimesSync(join(runsDir, `${id}.json`), recent, recent);
      const held = readDrainRedTeamEvidence(key);
      if (held.ok !== false || held.reason !== 'scan-capped' || cardOnlyHeadMoveCandidate(held, head)) {
        violations.push('#6507: hidden unfinished review was ignored by the capped carry fallback');
      }

    } catch (error) {
      violations.push(`scenario failed: ${error.message}`);
    } finally {
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    }
    return { violations };
  },
  judge: report => report.violations,
};
