/**
 * Default daemon stale scope: unrelated code lag must dispatch without dispatchPath;
 * gate / TRUST_CHAIN lag must still refuse. Real Git, real guard from sourceRoot.
 * fixPresent probes behavior so historical trees must reproduce the break.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const CHILD = `
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const { assertMainNotStale, isStaleMainRefusalMessage } = await import(
  pathToFileURL(join(process.env.SOAK_SOURCE_ROOT, 'scripts/lib/main-staleness.mjs')).href);
const { TRUST_CHAIN } = await import(
  pathToFileURL(join(process.env.SOAK_SOURCE_ROOT, 'scripts/lib/gate-config.mjs')).href);
const root = process.env.SOAK_CLONE;
// Model a daemon with a complete, unrelated entry closure; use the default entryModule.
process.argv[1] = join(root, 'scripts/daemon.mjs');
const out = { dispatched: false, refused: false, error: null,
  trustPath: 'scripts/lib/' + TRUST_CHAIN.find((m) => m.file !== 'gate-config.mjs').file };
try {
  assertMainNotStale(root, undefined, { codeRoot: root });
  out.dispatched = true;
} catch (e) {
  out.refused = isStaleMainRefusalMessage(e.message);
  out.error = String(e.message).split('\\n')[0];
}
process.stdout.write(JSON.stringify(out));
`;

const git = (cwd, ...args) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, maxBuffer: 1024 * 1024,
});

function probe(sourceRoot, log, { unrelatedOnly = false, strictOnly = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'soak-daemon-stale-scope-'));
  const violations = [];
  try {
    const seed = join(dir, 'seed');
    const clone = join(dir, 'clone');
    mkdirSync(join(seed, 'scripts/lib'), { recursive: true });
    git(seed, 'init', '-q', '-b', 'main');
    git(seed, 'config', 'user.email', 'soak@example.invalid');
    git(seed, 'config', 'user.name', 'soak');
    writeFileSync(join(seed, 'scripts/daemon.mjs'), "import { guard } from './lib/guard-closure.mjs';\nexport const daemon = guard;\n");
    writeFileSync(join(seed, 'scripts/lib/guard-closure.mjs'),
      "import { collectImportClosure } from './import-closure.mjs';\nexport const guard = collectImportClosure;\n");
    // Include the real scanner in the exercised graph: a synthetic leaf cannot catch self-matches.
    writeFileSync(join(seed, 'scripts/lib/import-closure.mjs'),
      readFileSync(join(sourceRoot, 'scripts/lib/import-closure.mjs'), 'utf8'));
    git(seed, 'add', '.');
    git(seed, 'commit', '-q', '-m', 'daemon baseline');
    // Shared local objects let us advance origin/main without fetch, push or network IO.
    git(dir, 'clone', '-q', '--shared', seed, clone);
    const child = join(dir, 'probe.mjs');
    writeFileSync(child, CHILD);
    const dispatch = () => JSON.parse(execFileSync(process.execPath, [child], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, SOAK_SOURCE_ROOT: sourceRoot, SOAK_CLONE: clone,
        WE_DAEMON_MANAGED_CLONE: '1', WE_DAEMON_STATE_DIR: join(dir, 'state') },
    }));
    const lag = (path) => {
      writeFileSync(join(seed, path), '// main advanced\n');
      git(seed, 'add', '.');
      git(seed, 'commit', '-q', '-m', `advance ${path}`);
      git(clone, 'update-ref', 'refs/remotes/origin/main', git(seed, 'rev-parse', 'HEAD').trim());
    };
    lag('scripts/unrelated.mjs');
    const unrelated = dispatch();
    log?.(`unrelated lag: ${JSON.stringify(unrelated)}`);
    if (!strictOnly && (!unrelated.dispatched || unrelated.refused || unrelated.error)) {
      violations.push({ invariant: 'default-scope-dispatches-unrelated-code-lag',
        detail: `no dispatchPath, but unrelated code lag did not dispatch: ${JSON.stringify(unrelated)}` });
    }
    // Presence is determined solely by the positive, unrelated-lag behavior.
    if (unrelatedOnly) return { violations };
    lag('scripts/lib/guard-closure.mjs');
    const closure = dispatch();
    log?.(`imported guard lag: ${JSON.stringify(closure)}`);
    if (closure.dispatched || !closure.refused) {
      violations.push({ invariant: 'default-scope-refuses-imported-guard-lag', detail: JSON.stringify(closure) });
    }
    git(clone, 'reset', '--hard', 'origin/main');
    lag('scripts/lib/gate-config.mjs');
    const gate = dispatch();
    log?.(`gate lag: ${JSON.stringify(gate)}`);
    if (gate.dispatched || !gate.refused) {
      violations.push({ invariant: 'default-scope-refuses-gate-lag', detail: JSON.stringify(gate) });
    }
    // Catch up before isolating the other strict path; no prior gate lag can mask it.
    git(clone, 'reset', '--hard', 'origin/main');
    lag(unrelated.trustPath);
    const trust = dispatch();
    log?.(`TRUST_CHAIN lag: ${JSON.stringify(trust)}`);
    if (trust.dispatched || !trust.refused) {
      violations.push({ invariant: 'default-scope-refuses-trust-chain-lag', detail: JSON.stringify(trust) });
    }
  } catch (e) {
    violations.push({ invariant: 'scenario-runs',
      detail: String(e?.stderr || e?.message || e).split('\n').slice(0, 3).join(' | ') });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { violations };
}

export default {
  id: 'daemon-stale-guard-refuses-unrelated-lag',
  title: 'the default daemon stale guard dispatches unrelated lag but refuses gate and trust-chain lag',
  card: 'assertMainNotStale default import-closure scoping',
  fixedBy: {
    sha: 'HEAD', where: 'working tree: default import-closure scoping',
    paths: ['scripts/lib/main-staleness.mjs', 'scripts/lib/import-closure.mjs'],
  },
  fixPresent(root) { return probe(root, undefined, { unrelatedOnly: true }).violations.length === 0; },
  async run({ log, sourceRoot = REPO_ROOT, strictOnly = false } = {}) { return probe(sourceRoot, log, { strictOnly }); },
  judge(report) { return report.violations.map((v) => `[${v.invariant}] ${v.detail}`); },
};
