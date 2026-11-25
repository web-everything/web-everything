/** SHADOW-FIX-AGY-CARBON-SEATS: a read_file void must hand its daily slot back, and never change the answer. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const SOURCE = 'scripts/operations/review-seat-runner.mjs';
const BUDGET = 'scripts/lib/review-shadow-budget.mjs';
const SCRIPT = (root, store) => `
  process.env.WE_REVIEW_SEAT_CAP_AGY_GEMINI = '0';
  process.env.WE_REVIEW_SEAT_CAP_CARBON_SHADOW = '5';
  const { runSeatWithProvider } = await import(${JSON.stringify(pathToFileURL(join(root, SOURCE)).href)});
  const { reserveShadowSession, releaseShadowSession } = await import(${JSON.stringify(pathToFileURL(join(root, BUDGET)).href)});
  const path = ${JSON.stringify(store)};
  const seat = reasons => runSeatWithProvider({ seatProvider: { mode: 'shadow', model: 'gemini-4-carbon-high', dailyCap: 1 } }, {
    claudeJudge: async () => ({ value: { findings: [] }, telemetry: { sessionId: 'claude' } }),
    unwrap: x => x, wrap: value => value, cwd: null, log() {}, appendRow: () => true,
    reserveSession: args => reserveShadowSession({ ...args, path }),
    releaseSession: args => releaseShadowSession({ ...args, path }),
    agyJuror: async () => ({ status: 'voided', reasons }),
  });
  const bad = ['read_file (missing or invalid in-lane path) [a.txt]'];
  await seat(bad);
  const other = await seat(['change outside the juror lane']); // the first void gave its slot back; this one keeps it
  const held = await seat(bad);
  process.stdout.write(other.shadow.status === 'voided' && held.shadow.status === 'skipped' ? 'freed' : 'burned');
`;
const probe = (root) => {
  const dir = mkdtempSync(join(tmpdir(), 'soak-agy-void-'));
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', SCRIPT(root, join(dir, 'agree'))], {
      encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return !result.error && result.status === 0 ? result.stdout : `error:${result.stderr?.slice(0, 200)}`;
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

export default {
  id: 'agy-carbon-void-frees-slot',
  title: 'A read_file-voided Carbon shadow seat gives its daily slot back; other voids keep theirs',
  card: 'SHADOW-FIX-AGY-CARBON-SEATS',
  fixedBy: { sha: 'working-tree', where: SOURCE, paths: [SOURCE, BUDGET] },
  fixPresent: (root) => probe(root) === 'freed',
  run: async ({ sourceRoot = ROOT } = {}) => {
    const out = probe(sourceRoot);
    return { violations: out === 'freed' ? [] : [`void slot behaviour: ${out}`] };
  },
  judge: report => report.violations,
};
