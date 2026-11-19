/** A reservation denial must survive policy exhaustion without launching outside the operator chain. */
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const MODULE = 'scripts/conveyor/soak/breaks/red-team-reservation-route-exhaustion.mjs';
export default {
  id: 'red-team-reservation-route-exhaustion',
  title: 'red-team operator caps and reservation denial survive speculative routing',
  card: 'red-team reservation route exhaustion',
  fixedBy: { sha: 'working-tree', where: 'current tree', paths: ['scripts/operations/review-extra-seats.mjs', 'scripts/operations/review-job.mjs'] },
  fixPresent(root) {
    // The harness needs a synchronous predicate. Exercise the same hermetic behavior
    // in a bounded child rather than infer presence from a source-code substring.
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const {default:b}=await import(${JSON.stringify(pathToFileURL(join(root, MODULE)).href)}); const r=await b.run({sourceRoot:${JSON.stringify(root)}}); process.exitCode=b.judge(r).length?1:0;`],
    { cwd: root, env: process.env, encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 });
    return probe.status === 0;
  },
  async run({ sourceRoot = ROOT } = {}) {
    const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
    const { speculateRedTeam, reserveSeatCalls } = await load('scripts/operations/review-extra-seats.mjs');
    const { DEFAULT_ROUTING_POLICY } = await load('scripts/lib/dispatch-routing-policy.mjs');
    const { reviewSeatLaunchEnv, resolveProviderCap } = await load('scripts/lib/review-seat-caps.mjs');
    const violations = [];
    if (typeof reviewSeatLaunchEnv !== 'function') return { violations: ['launcher does not preserve operator caps'] };
    const policy = structuredClone(DEFAULT_ROUTING_POLICY);
    policy.operations['review-seat:red-team'] = { provider: 'codex', model: 'sol', fallback: [] };
    const now = Date.parse('2026-11-19T12:00:00Z');
    const operator = { WE_REVIEW_SEAT_CAP_CODEX: '5000', WE_REVIEW_SEAT_CAP_AGY_CLAUDE: '0', WE_REVIEW_SEAT_CAP_AGY_GEMINI: '0' };
    const env = reviewSeatLaunchEnv(operator, { WE_REVIEW_SEAT_CAP_CODEX: '80', WE_REVIEW_SEAT_CAP_AGY_CLAUDE: '300' });
    for (const p of ['codex', 'agy-claude', 'agy-gemini']) {
      if (resolveProviderCap(p, env) !== resolveProviderCap(p, operator)) violations.push(`${p}: cap changed in child`);
    }
    for (const deny of [false, true]) {
      const launched = [], reserved = [];
      const io = {
        now: () => now, log() {}, readRecords: () => [], cliAvailable: () => true,
        readRoutingPolicy: () => policy, readAiRouting: () => ({}),
        reserveCalls: o => {
          reserved.push(o.provider);
          return reserveSeatCalls({ ...o, ledger: null, records: [],
            want: deny ? 0 : o.want, newId: () => 'soak-call' });
        },
        makeScratch: () => 'soak-seat', removeScratch() {}, writeFile() {}, readHeadMessage: () => '',
        runSeat: async o => { launched.push(o.provider); return { report: { lastMessage: JSON.stringify({ lenses: { 'red-team': { verdict: 'accept', findings: [] } } }) } }; },
      };
      // Leave an out-of-chain roster provider available after the denied reservation.
      const result = await speculateRedTeam({ pr: 1, repo: 'example/project', lanePath: 'soak-lane',
        env: deny ? { ...env, WE_REVIEW_SEAT_CAP_AGY_CLAUDE: '300' } : env, post: false, record: false,
        read: { title: 'fix', body: '', diffText: 'diff --git a/x.mjs b/x.mjs\n+1\n',
          netChangedFiles: ['x.mjs'], netBasis: { rev: 'a'.repeat(40) } } }, io);
      if (JSON.stringify(reserved) !== '["codex"]') violations.push('reserved outside the override chain');
      if (deny) {
        if (result.status !== 'skipped' || !result.deferredByCap || !result.reason?.includes('for codex')
          || result.reason.includes('no available route') || launched.length) violations.push('reservation denial masked by policy or launched a seat');
      } else if (result.status !== 'speculated' || JSON.stringify(launched) !== '["codex"]') violations.push('Codex capacity skipped');
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
