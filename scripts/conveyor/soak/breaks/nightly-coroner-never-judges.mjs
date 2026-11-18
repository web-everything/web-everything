/** R471: the nightly coroner stopped after extraction, so NEW frictions never reached the held cards list. */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractNightlyCoroner } from '../../nightly-coroner-job.mjs';

const SOURCE = 'scripts/conveyor/nightly-coroner-job.mjs';
const metrics = { errorRates: { gateRuns: { causes: { timeout: { count: 4, minutes: 90, examples: [{ ref: 'PR #1', at: '2026-10-17T00:00:00.000Z' }] } } } } };
export default {
  id: 'nightly-coroner-never-judges',
  title: 'a scheduled nightly coroner run ranks, judges NEW vs COVERED-BY and appends only the NEW card to the held list, once',
  card: 'R471',
  fixedBy: { sha: 'HEAD', where: 'lane/coroner-judge-step', paths: [SOURCE, 'scripts/operations/coroner-judge.mjs'] },
  fixPresent(root) { return readFileSync(join(root, SOURCE), 'utf8').includes('runCoronerJudge'); },
  async run({ log } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'soak-coroner-judge-'));
    const violations = [];
    try {
      const home = join(root, 'handoff'), dir = join(root, 'state'), lane = { lane: 7, holder: 'soak', path: join(root, 'lane') };
      mkdirSync(join(lane.path, 'scripts/operations'), { recursive: true }); mkdirSync(home, { recursive: true });
      writeFileSync(join(lane.path, 'scripts/operations/coroner-extract.mjs'), '');
      const input = { night: '2026-10-16', until: '2026-10-17T02:17:00.000Z', dir, sourceRoot: root };
      let judged = 0;
      const io = { root, home, statusFeed: join(home, 'needs-you-events.jsonl'), acquire: async () => lane, release: async () => {}, sweep: async () => {},
        run: async () => JSON.stringify(metrics), readCoverage: () => ({ held: '', openPrs: [], recentCards: [] }),
        judge: async () => { judged += 1; return { value: { verdicts: [{ key: 'gateRuns:timeout', verdict: 'NEW', coveredBy: null, proposedFix: 'Bound gate waits in the runner.' }] } }; } };
      await extractNightlyCoroner(input, io);
      await extractNightlyCoroner(input, io);
      const held = existsSync(join(home, 'cards-to-file.md')) ? readFileSync(join(home, 'cards-to-file.md'), 'utf8') : '';
      if (judged !== 1) violations.push(`judge ran ${judged} times, want 1`);
      if ((held.match(/Coroner key: gateRuns:timeout/g) ?? []).length !== 1) violations.push('NEW card was not appended exactly once');
      log?.(`judge calls ${judged}; ${violations.length} violations`);
      return { violations };
    } finally { rmSync(root, { recursive: true, force: true }); }
  },
  judge(report) { return report.violations; },
};
