/** A smoke-passed candidate carrying a benignly removed overlay is adopted, then rebuilt without it.
 * Replay the review daemon's 2026-11-18 17:28 ET overlay-no-longer-wanted discard.
 * Unsafe and unknown removals still discard the candidate. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const ADOPT = 'scripts/lib/daemon-rebuild/adopt.mjs';
const SHA = (c) => c.repeat(40);

const base = (over = {}) => ({
  ready: { kind: 'candidate', prevHead: 'live', passedAt: '2026-11-18T22:28:00Z', tree: 'ready-tree',
    adopt: { finalSha: SHA('f'), inputsKey: 'k', applied: [{ ref: 'lane/a', sha: SHA('a') }] } },
  plan: { finalSha: SHA('e'), inputsKey: 'k2', mainSha: SHA('1'), alerts: [], decisions: [] },
  prevHead: 'live', treeOf: () => 'plan-tree', stillWanted: () => true, verifyBuilt: () => true,
  nowMs: Date.parse('2026-11-18T22:50:00Z'), maxAgeMs: 3_600_000, liveApplied: [], ...over,
});
const gone = { stillWanted: (ref) => ref !== 'lane/a', registered: (ref) => ref !== 'lane/a' };
/** Replay the authenticated removal writer contract with hermetic executables. */
export async function registryContractViolations(sourceRoot = REPO_ROOT) {
  const from = (file) => import(pathToFileURL(resolve(sourceRoot, file)).href);
  const { addOverlay, appendOverlayEvent } = await from('scripts/lib/daemon-overlays.mjs');
  const { readOverlayEventLog } = await from('scripts/lib/daemon-rebuild/prepare.mjs');
  const { matchReadyCandidate, classifyOverlayRemoval } = await from(ADOPT);
  const { OPERATOR_LOGINS } = await from('scripts/lib/marker-authorship.mjs');
  const root = mkdtempSync(join(tmpdir(), 'soak-adopt-registry-'));
  const env = { ...process.env, WE_DAEMON_OVERLAY_DIR: join(root, 'overlays') };
  const violations = [];
  try {
    addOverlay(root, { ref: 'lane/a', pr: 100 }, { env });
    appendOverlayEvent(root, { kind: 'added', ref: 'lane/a', at: '2026-11-18T20:00:00Z' }, { env });
    // Exercise the CLI's credential-to-writer adapter with hermetic executables, not an asserted actor.
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'git'), `#!/usr/bin/env node
const args = process.argv.slice(2);
process.stdout.write(args.includes('ls-remote') ? ${JSON.stringify(`${SHA('a')}\trefs/heads/lane/a\n`)} : 'fixture-origin\\n');
`, { mode: 0o755 });
    writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
if (process.argv[2] !== 'api' || process.argv[3] !== 'user') process.exit(1);
process.stdout.write(${JSON.stringify(`${OPERATOR_LOGINS[0]}\n`)});
`, { mode: 0o755 });
    const output = execFileSync(process.execPath, [resolve(sourceRoot, 'scripts/daemon-overlay.mjs'), 'remove', `--clone=${root}`,
      '--ref=lane/a', '--reason=no longer wanted', '--json'], {
      env: { ...env, PATH: `${bin}:${env.PATH ?? ''}`, GH_TOKEN: 'stub', HOME: root }, timeout: 10_000, stdio: 'pipe', encoding: 'utf8',
    });
    const events = readOverlayEventLog(root, env);
    if (JSON.parse(output).removed !== true || events.at(-1)?.kind !== 'removed' || events.at(-1)?.tip !== SHA('a')) {
      violations.push({ invariant: 'real-removal-writer', detail: 'CLI did not record removal of the expected tip' });
    }
    const removal = classifyOverlayRemoval({ ref: 'lane/a', sha: SHA('a'), events });
    if (removal !== 'benign') violations.push({ invariant: 'real-removal-adopts', detail: removal });
    return violations;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

export const CASES = [
  { id: 'benign-removal-adopts', args: { ...gone, removalSafety: () => 'benign' }, adopts: true, rebuildAfter: ['lane/a'] },
  { id: 'unsafe-removal-discards', args: { ...gone, removalSafety: () => 'unsafe' }, adopts: false, reason: 'overlay-no-longer-wanted' },
  { id: 'unknown-removal-discards', args: { ...gone }, adopts: false, reason: 'overlay-no-longer-wanted' },

];

/** Behavioural probe, run in a child so `fixPresent` stays synchronous. */
const PROBE = `
const { matchReadyCandidate } = await import(process.argv[1]);
const m = matchReadyCandidate({
  ready: { kind: 'candidate', prevHead: 'live', passedAt: '2026-11-18T22:28:00Z', tree: 'ready-tree',
    adopt: { finalSha: 'f'.repeat(40), inputsKey: 'k', applied: [{ ref: 'lane/a', sha: 'a'.repeat(40) }] } },
  plan: { finalSha: 'e'.repeat(40), inputsKey: 'k2', mainSha: '1'.repeat(40), alerts: [] },
  prevHead: 'live', treeOf: () => 'plan-tree', verifyBuilt: () => true, liveApplied: [],
  nowMs: Date.parse('2026-11-18T22:50:00Z'), maxAgeMs: 3600000,
  stillWanted: (r) => r !== 'lane/a', registered: (r) => r !== 'lane/a', removalSafety: () => 'benign',
});
const { registryContractViolations } = await import(process.argv[2]);
const contracts = await registryContractViolations(process.argv[3]);
console.log(m.adopt && contracts.length === 0 ? 'yes' : 'no');
`;

export default {
  id: 'rebuild-adopt-then-add',
  title: 'a smoke-passed rebuild candidate survives a benign overlay removal',
  card: 'live 2026-11-18 17:28 ET: review daemon discarded a passing candidate after benign removal',
  fixedBy: { sha: 'pending', where: 'lane/rebuild-adopt-then-add', paths: [ADOPT, 'scripts/lib/daemon-rebuild/prepare.mjs',
    'scripts/daemon-overlay.mjs'] },
  fixPresent(root) {
    try {
      const url = pathToFileURL(resolve(root, ADOPT)).href;
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', PROBE, url, import.meta.url, root], { encoding: 'utf8', timeout: 20_000 });
      return out.trim() === 'yes';
    } catch { return false; }
  },
  async run({ log, sourceRoot = REPO_ROOT } = {}) {
    const violations = [];
    try {
      const { matchReadyCandidate } = await import(pathToFileURL(resolve(sourceRoot, ADOPT)).href);
      violations.push(...await registryContractViolations(sourceRoot));
      for (const c of CASES) {
        const m = matchReadyCandidate({ ...base(), ...c.args });
        log?.(`${c.id}: ${m.adopt ? 'adopt' : m.reason}`);
        const ok = c.adopts
          ? !!m.adopt && JSON.stringify([...(m.rebuildAfter ?? [])].sort()) === JSON.stringify(c.rebuildAfter)
          : !m.adopt && m.reason === c.reason;
        if (!ok) violations.push({ invariant: c.id, detail: `expected ${c.adopts ? 'adopt' : c.reason}, got ${m.adopt ? 'adopt' : m.reason}` });
      }
    } catch (e) {
      violations.push({ invariant: 'crash', detail: String(e?.message ?? e) });
    }
    return { violations };
  },
  judge(report) { return report.violations.map((v) => `[${v.invariant}] ${v.detail}`); },
};
