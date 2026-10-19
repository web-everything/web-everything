/** PR #5450: Node canonicalizes the main module while extractor guards compare argv literally. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractNightlyCoroner } from '../../nightly-coroner-job.mjs';

const SOURCE = 'scripts/conveyor/nightly-coroner-job.mjs';
export default {
  id: 'nightly-coroner-symlinked-lane',
  title: 'nightly extraction publishes both CLI results when the lane and scripts use symlinked paths',
  card: 'PR #5450',
  fixedBy: { sha: 'HEAD', where: 'lane/coroner-job', paths: [SOURCE] },
  fixPresent(root) {
    const source = readFileSync(join(root, SOURCE), 'utf8');
    return source.includes("realpathSync(join(lane.path, 'scripts/operations/coroner-extract.mjs'))")
      && source.includes('run([realpathSync(optional), ...args]');
  },
  async run({ log } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'soak-nightly-coroner-'));
    const violations = [];
    try {
      const physicalLane = join(root, 'physical lane'), lanePath = join(root, 'lane alias');
      const ops = join(physicalLane, 'scripts/operations');
      mkdirSync(ops, { recursive: true });
      symlinkSync(physicalLane, lanePath, 'dir');
      symlinkSync(fileURLToPath(new URL('../../../operations/coroner-extract.mjs', import.meta.url)), join(ops, 'coroner-extract.mjs'));
      const optional = join(root, 'optional extractor.mjs');
      writeFileSync(optional, `import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify({ cli: true }));
`);
      symlinkSync(optional, join(ops, 'coroner-false-findings.mjs'));
      const env = { ...process.env, WE_CORONER_NO_CI: '1', WE_CORONER_NO_ROUNDS: '1', WE_CORONER_NO_EXECUTORS: '1' };
      for (const key of ['JOBS', 'JOBS_ARCHIVE', 'PROJECTS', 'DAEMON_DIR', 'VERIFY_LOG', 'ADMISSION', 'LANES', 'STATE', 'COORD', 'BACKLOG', 'LAUNCH_AGENTS', 'RECEIPTS']) {
        env[`WE_CORONER_${key}`] = join(root, key.toLowerCase());
      }
      // Probe the actual CLI surface without invoking lane-pool, GitHub, or operator state.
      const input = { night: '2026-10-16', until: '2026-10-17T02:17:00.000Z', dir: join(root, 'state') };
      const lane = { lane: 7, holder: 'soak-coroner', path: lanePath };
      let acquired = 0, released = 0, swept = 0, calls = 0;
      const io = { home: join(root, 'handoff'), statusFeed: join(root, 'feed.jsonl'),
        acquire: async () => { acquired++; return lane; },
        release: async (value) => { released++; if (value !== lane) violations.push('released a different lease'); },
        sweep: async () => { swept++; },
        run: async (args, cwd) => {
          calls++;
          const stdout = execFileSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout: 5000 });
          log?.(`CLI ${calls}: ${stdout.length} stdout bytes; canonical argv=${args[0] === realpathSync(args[0])}`);
          return stdout;
        } };
      try {
        const result = await extractNightlyCoroner(input, io);
        const report = readFileSync(join(io.home, result.report), 'utf8');
        if (!report.includes('"errorRates"') || !report.includes('"cli": true')) violations.push('missing extractor CLI results');
        if (JSON.parse(readFileSync(join(input.dir, 'nightly-coroner-cursor.json'), 'utf8')).lastEnd !== input.until) violations.push('cursor not published');
        // Recovery must reuse the receipt without acquiring another lane or rerunning either CLI.
        await extractNightlyCoroner(input, io);
        if (calls !== 2 || acquired !== 1) violations.push('unexpected extraction or acquisition count');
        if (swept !== 1) violations.push(`expected one orphan lease sweep, got ${swept}`);
        if (readFileSync(io.statusFeed, 'utf8').trim().split('\n').length !== 1) violations.push('duplicate notification');
      } catch (error) {
        violations.push(`extraction failed: ${error.message}`);
        if (existsSync(join(input.dir, 'nightly-coroner-cursor.json'))) violations.push('failed extraction advanced cursor');
      }
      if (released !== 1) violations.push(`expected one lane release, got ${released}`);
      return { violations };
    } finally { rmSync(root, { recursive: true, force: true }); }
  },
  judge(report) { return report.violations; },
};
