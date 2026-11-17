/** Card x3v2chw: oversized coverage must be judged in bounded chunks rather than fail every retry. */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { extractNightlyCoroner, readJudgeCoverage } from '../../nightly-coroner-job.mjs';

const SOURCE = 'scripts/conveyor/nightly-coroner-job.mjs';
// A synchronous behavioral probe keeps fixPresent compatible with the soak registry.
// Its IO is entirely fixture-owned; the root argument selects the implementation being probed.
const FIX_PROBE = `
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { extractNightlyCoroner, readJudgeCoverage } = await import(pathToFileURL(join(process.argv[1], 'scripts/conveyor/nightly-coroner-job.mjs')));
const root = process.argv[2], home = join(root, 'home'), dir = join(root, 'state');
mkdirSync(home); mkdirSync(join(root, 'backlog'));
const lane = { lane: 7, holder: 'probe', path: join(root, 'lane') };
mkdirSync(join(lane.path, 'scripts/operations'), { recursive: true });
writeFileSync(join(lane.path, 'scripts/operations/coroner-extract.mjs'), '');
const entries = Array.from({ length: 3 }, (_, i) => (i + 1) + '. context\\n' + 'x'.repeat(200000) + '\\ncovering fix\\n');
const held = entries.join(''), card = 'card context\\n' + 'x'.repeat(20000) + '\\ncovering fix';
writeFileSync(join(home, 'cards-to-file.md'), held);
writeFileSync(join(root, 'backlog', 'one.md'), card);
writeFileSync(join(root, 'backlog', 'two.md'), card);
const chunks = [];
await extractNightlyCoroner({ night: '2026-11-16', until: '2026-11-17T03:17:00.000Z', dir, sourceRoot: root }, {
  root, home, statusFeed: join(home, 'feed.jsonl'), acquire: async () => lane, release: async () => {}, sweep: async () => {},
  run: async () => JSON.stringify({ errorRates: { gates: { causes: { timeout: { count: 1, minutes: 1, examples: [{ ref: 'PR #1' }] } } } } }),
  readCoverage: () => readJudgeCoverage(root, home, () => '[]'),
  fileItem: async () => { throw new Error('covered evidence must not file'); },
  judge: async ({ input }) => {
    chunks.push(JSON.parse(input.slice(input.indexOf('{'), input.lastIndexOf('}') + 1)));
    return { value: { verdicts: [{ key: 'gates:timeout', verdict: 'COVERED-BY', coveredBy: 'existing-card' }] } };
  },
});
assert.equal(chunks.length, 2);
assert.equal(chunks.map(c => c.held).join(''), held);
for (const entry of entries) assert.equal(chunks.filter(c => c.held.includes(entry)).length, 1);
assert.equal(chunks.flatMap(c => c.recentCards).length, 2);
for (const chunk of chunks) {
  assert.ok(Buffer.byteLength(chunk.held) <= 512 * 1024);
  assert.ok(chunk.recentCards.reduce((n, c) => n + Buffer.byteLength(c.content), 0) <= 32 * 1024);
  for (const c of chunk.recentCards) assert.equal(c.content, card);
}
process.stdout.write('chunked-intact');
`;

export default {
  id: 'nightly-coroner-oversized-chunks',
  title: 'oversized nightly evidence is chunked and merged with one filing cap; total overflow defers to manual coroner',
  card: '8560',
  fixedBy: { sha: 'HEAD', where: SOURCE, paths: [SOURCE] },
  fixPresent(root) {
    const scratch = mkdtempSync(join(tmpdir(), 'soak-coroner-chunks-probe-'));
    try {
      const probe = spawnSync(process.execPath, ['--input-type=module', '-e', FIX_PROBE, root, scratch], {
        encoding: 'utf8', timeout: 10000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
      });
      return probe.status === 0 && probe.stdout === 'chunked-intact';
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  },
  async run({ log } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'soak-coroner-chunks-'));
    const violations = [];
    try {
      const home = join(root, 'handoff'), dir = join(root, 'state');
      const lane = { lane: 7, holder: 'soak', path: join(root, 'lane') };
      mkdirSync(join(lane.path, 'scripts/operations'), { recursive: true });
      mkdirSync(home); mkdirSync(join(root, 'backlog'));
      writeFileSync(join(lane.path, 'scripts/operations/coroner-extract.mjs'), '');
      const entries = Array.from({ length: 3 }, (_, i) => `${i + 1}. Identifying context ${i}\n${'x'.repeat(200000)}\ncovering fix ${i}\n`);
      const held = entries.join(''), content = 'card context\n' + 'x'.repeat(20000) + '\ncovering fix';
      writeFileSync(join(home, 'cards-to-file.md'), held);
      writeFileSync(join(root, 'backlog', 'large.md'), content);
      writeFileSync(join(root, 'backlog', 'other.md'), content);
      const metrics = { errorRates: { gateRuns: { causes: { timeout: { count: 4, minutes: 90, examples: [{ ref: 'PR #1' }] } } } } };
      const input = { night: '2026-11-16', until: '2026-11-17T03:17:00.000Z', dir, sourceRoot: root, nightly: { judge: { maxCards: 1 } } };
      const chunks = [];
      let filed = 0, beforeJudgment = 0, veto = false;
      const io = { root, home, statusFeed: join(home, 'feed.jsonl'), acquire: async () => lane, release: async () => {}, sweep: async () => {},
        run: async () => JSON.stringify(metrics), readCoverage: () => readJudgeCoverage(root, home, () => '[]'),
        fileItem: async () => ({ id: `card-${++filed}` }),
        judge: async ({ input }) => {
          if (filed !== beforeJudgment) violations.push('filed before every chunk was judged');
          chunks.push(JSON.parse(input.slice(input.indexOf('{'), input.lastIndexOf('}') + 1)));
          if (veto && chunks.length % 2 === 0) return { value: { verdicts: [{ key: 'gateRuns:timeout', verdict: 'COVERED-BY', coveredBy: 'existing-card' }] } };
          return { value: { verdicts: [{ key: 'gateRuns:timeout', verdict: 'NEW', proposedFix: 'Bound gate waits.' }] } };
        } };
      await extractNightlyCoroner(input, io);
      await extractNightlyCoroner(input, io);
      if (chunks.length !== 2 || filed !== 1) violations.push(`judge calls ${chunks.length}, filings ${filed}; want 2 and 1`);
      if (chunks.map((c) => c.held).join('') !== held || chunks.flatMap((c) => c.recentCards).map((c) => c.content).join('') !== content.repeat(2)) violations.push('coverage lost during chunking');
      if (entries.some((entry) => chunks.filter((c) => c.held.includes(entry)).length !== 1) || chunks.flatMap((c) => c.recentCards).some((card) => card.content !== content)) violations.push('entry or card split across chunks');
      if (chunks.some((c) => Buffer.byteLength(c.held) > 512 * 1024 || c.recentCards.reduce((n, c) => n + Buffer.byteLength(c.content), 0) > 32 * 1024)) violations.push('chunk bound exceeded');
      const report = readFileSync(join(home, `coroner-${input.night}.md`), 'utf8');
      const result = JSON.parse(report.split('\n').find((line) => line.startsWith('{"ranked":')));
      if (result.ranked.length !== 1 || result.verdicts.length !== 1 || result.filed.length !== 1 || result.error !== null) violations.push('chunk results not merged');
      beforeJudgment = filed; veto = true;
      await extractNightlyCoroner({ ...input, dir: join(root, 'veto-state'), night: '2026-11-17', until: '2026-11-18T03:17:00.000Z' }, io);
      if (chunks.length !== 4 || filed !== 1) violations.push('later COVERED-BY failed to veto earlier NEW');
      const vetoReport = readFileSync(join(home, 'coroner-2026-11-17.md'), 'utf8');
      const vetoResult = JSON.parse(vetoReport.split('\n').find((line) => line.startsWith('{"ranked":')));
      if (vetoResult.filed.length || vetoResult.verdicts[0]?.verdict !== 'COVERED-BY') violations.push('covered verdict lost during merge');
      const checkDeferral = async (expected) => {
        let failure;
        try { await extractNightlyCoroner({ ...input, night: '2026-11-18', until: '2026-11-19T03:17:00.000Z' }, io); } catch (e) { failure = e.message; }
        if (failure !== expected || chunks.length !== 4 || filed !== 1) violations.push(`manual deferral failed: ${expected}`);
      };
      writeFileSync(join(home, 'cards-to-file.md'), '1. context\n' + 'x'.repeat(512 * 1024) + '\ncovering fix');
      await checkDeferral('coroner coverage entry exceeds chunk cap; run manual /coroner');
      writeFileSync(join(home, 'cards-to-file.md'), held);
      writeFileSync(join(root, 'backlog', 'large.md'), 'card context\n' + 'x'.repeat(32 * 1024) + '\ncovering fix');
      await checkDeferral('coroner coverage entry exceeds chunk cap; run manual /coroner');
      writeFileSync(join(root, 'backlog', 'large.md'), content);
      writeFileSync(join(home, 'cards-to-file.md'), 'x'.repeat(4 * 1024 * 1024 + 1));
      await checkDeferral('coroner coverage exceeds total ceiling; run manual /coroner');
      log?.(`${chunks.length} chunks; ${violations.length} violations`);
      return { violations };
    } finally { rmSync(root, { recursive: true, force: true }); }
  },
  judge(report) { return report.violations; },
};
