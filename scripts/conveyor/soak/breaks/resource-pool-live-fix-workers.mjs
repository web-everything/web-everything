/** R1094 S1a: replay the live observation of C3=0 while a leased fixer consumed 2u. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SOURCE = 'scripts/lib/resource-pool-io.mjs';
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

export default {
  id: 'resource-pool-live-fix-workers',
  title: 'a live leased fix worker must consume C3 shadow units even without a fix claim or heavy slot',
  card: 'R1094 S1a; PR #7353 live C3 undercount',
  fixedBy: { sha: 'e99f6474c0', where: 'lane/resource-pool-s1a', paths: [SOURCE] },
  fixPresent(root) {
    const file = join(root, SOURCE);
    return existsSync(file) && readFileSync(file, 'utf8').includes("source === 'workers'");
  },
  async run({ log } = {}) {
    const root = process.env.SOAK_TREE_ROOT || ROOT;
    const { collectResourcePool, readPoolSource, appendShadowRows } = await import(pathToFileURL(join(root, SOURCE)).href);
    const { POOL_DEFAULTS } = await import(pathToFileURL(join(root, 'scripts/lib/resource-pool.mjs')).href);
    const coord = mkdtempSync(join(tmpdir(), 'soak-pool-workers-'));
    const paths = { snapshot: join(coord, 'resource', 'snapshot.json'), fix: join(coord, 'fix'), redTeam: join(coord, 'red-team') };
    const nowMs = Date.parse('2026-11-22T12:00:00Z');
    const violations = [];
    const check = (ok, message) => { if (!ok) violations.push(message); };
    let lanes = [
      { path: join(coord, 'lane-1'), leased: true, lease: { session: 'fix-7343', purpose: 'conveyor-fix', acquiredAt: new Date(nowMs - 1000).toISOString(), ttlMinutes: 1 } },
      { path: join(coord, 'lane-2'), leased: false, lease: { session: 'ci-heal-7337', purpose: 'conveyor-ci-heal', acquiredAt: new Date(nowMs - 120000).toISOString(), ttlMinutes: 1 } },
    ];
    let failLaneRead = false, failHeavyRead = false, heavy = [];
    const readSource = source => readPoolSource(source, {
      paths, coord, env: {}, nowMs,
      listCommands: () => `${process.pid} 1 node soak-pool-workers`,
      roundBudget: () => ({ live: 0 }),
      laneStatus: () => { if (failLaneRead) throw Error('fixture lane inventory unreadable'); return { lanes }; },
      heavyStatus: () => { if (failHeavyRead) throw Error('fixture heavy inventory unreadable'); return { held: heavy }; },
    });
    const collect = () => collectResourcePool({ paths, coord, env: {}, nowMs, readSource,
      settings: { value: structuredClone(POOL_DEFAULTS), configuredMode: 'shadow', unknown: false },
      legacy: () => ({ verdict: 'admit', unknown: false }),
    });
    const observe = (label, unknown, job) => {
      const report = collect();
      check(report.unknown === unknown, `${label}: wrong unknown verdict`);
      check(report.sources.find(s => s.source === 'workers')?.ok === !unknown, `${label}: worker source status missing/wrong`);
      check(report.rows.length === 3 && report.rows.every(r => r.legacyDecision === 'grant'), `${label}: lost legacy comparisons`);
      if (unknown) {
        check(report.rows.every(r => r.unknown && r.poolDecision === 'hold'), `${label}: incomplete evidence allowed a shadow grant`);
        check(report.digest.includes('?/?'), `${label}: digest presented unknown capacity as known`);
      } else {
        check(report.summary['studio.units'].classes[3] === 2, `${label}: live worker did not consume exactly 2 C3 units`);
        check(report.holders.length === 1 && report.holders[0].jobId === job, `${label}: stale, duplicate or missing worker`);
        check(report.digest === 'pool studio 2/30u · C2 0 C3 2 (floor 4)', `${label}: wrong live digest`);
      }
      check(appendShadowRows(report.rows, { coord, env: {}, mode: report.mode }), `${label}: shadow append failed`);
      log?.(`${label}: ${report.digest}`);
      return report;
    };
    try {
      mkdirSync(join(coord, 'resource')); mkdirSync(paths.fix); mkdirSync(paths.redTeam);
      writeFileSync(paths.snapshot, JSON.stringify({ sampledAt: new Date(nowMs - 1000).toISOString(),
        freshUntil: new Date(nowMs + 60_000).toISOString(),
        memory: { availableMb: 40000, floorMb: 4000, swapUsedPct: 10, swapGrowthMb: 0, pressureLevel: 1 }, cpu: { idlePct: 40 },
      }));
      observe('leased-fixer-without-claim', false, 'fix-7343');
      heavy = [{ owner: `${lanes[0].path}#123`, meta: { dispatchKind: 'fix', session: 'fix-7343' } }];
      observe('same-worker-heavy-slot', false, 'fix-7343');
      failLaneRead = true;
      observe('unreadable-lanes', true);
      failLaneRead = false; failHeavyRead = true;
      observe('unreadable-heavy-slots', true);
      failHeavyRead = false; heavy = [];
      lanes = lanes.map((lane, i) => ({ ...lane, leased: i === 1,
        lease: { ...lane.lease, acquiredAt: new Date(nowMs - (i === 1 ? 1000 : 120000)).toISOString() } }));
      observe('recovered-with-ci-healer', false, 'ci-heal-7337');
      const rows = readFileSync(join(coord, 'resource', 'pool-shadow.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      check(rows.length === 15 && rows.filter(row => row.unknown).length === 6, 'persisted shadow timeline lost observations or unknown holds');
      return { violations };
    } finally {
      rmSync(coord, { recursive: true, force: true });
    }
  },
  judge(report) { return report.violations; },
};
