import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const cli = resolve('scripts/verify-lane.mjs');
const admissionUrl = pathToFileURL(resolve('scripts/readiness/heavy-admission.mjs')).href;
const baseUrl = pathToFileURL(resolve('scripts/lib/verify-base-rerun.mjs')).href;
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function runCaller(caller, timedOut) {
  const root = mkdtempSync(join(tmpdir(), 'verify-admission-timeout-'));
  roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test',
    'commit', '--allow-empty', '-qm', 'fixture'], { cwd: root });
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: root });
  const events = join(root, '.git', 'events.jsonl');
  const gateStarted = join(root, '.git', 'gate-started');
  const baseStarted = join(root, '.git', 'base-gate-started');
  const gate = join(root, 'gate.mjs');
  const base = caller === 'withBaseRerunSlot';
  writeFileSync(gate, `import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(gateStarted)}, 'started'); process.exit(${base ? 1 : 0});`);
  const preferences = join(root, '.git', 'preferences.json');
  writeFileSync(preferences, JSON.stringify({ heavyAdmission: { remote: { enabled: false } } }));
  const loader = join(root, '.git', 'admission-loader.mjs');
  // Replace IO providers, leaving the CLI's admission callers, exit handling and lifecycle intact.
  // For base comparison the initial gate holds no local slot (the disabled-admission result),
  // so withBaseRerunSlot must make its own independent admission decision.
  const admissionSource = `export * from ${JSON.stringify(admissionUrl + '?fixture-original')};
    import { appendFileSync } from 'node:fs';
    let calls = 0;
    export const admissionLockRoot = () => ${JSON.stringify(join(root, '.git', 'admission'))};
    export const heartbeatOwnedSlot = () => {};
    export const releaseOwnedSlot = () => {};
    export async function acquireSlotBlocking(options) {
      calls++;
      const initial = ${base} && calls === 1;
      const result = initial ? { ok: false, slot: null, disabled: true, timedOut: false, waitedMs: 0 }
        : { ok: ${!timedOut}, slot: ${timedOut ? 'null' : '0'}, timedOut: ${timedOut}, waitedMs: 10 };
      appendFileSync(${JSON.stringify(events)}, JSON.stringify({ caller: initial ? 'initial' : ${JSON.stringify(caller)}, result }) + '\\n');
      return result;
    }`;
  const baseSource = `export * from ${JSON.stringify(baseUrl + '?fixture-original')};
    import { writeFileSync } from 'node:fs';
    export const baseRerunCandidate = () => ${base ? "({ files: ['baseline.test.mjs'], tests: [] })" : 'null'};
    export const measureBaseFailures = ({ files, runBase }) => runBase(files);
    export async function runVitestOnBase() {
      writeFileSync(${JSON.stringify(baseStarted)}, 'started');
      return { ok: true, tests: [] };
    }`;
  writeFileSync(loader, `export async function load(url, context, nextLoad) {
    if (url === ${JSON.stringify(admissionUrl)}) return { format: 'module', shortCircuit: true, source: ${JSON.stringify(admissionSource)} };
    if (url === ${JSON.stringify(baseUrl)}) return { format: 'module', shortCircuit: true, source: ${JSON.stringify(baseSource)} };
    return nextLoad(url, context);
  }`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(WE_HEAVY_|WE_VERIFY_|VERIFY_|WE_BUILD_FINAL_|WE_LOAD_|WE_QUEUE_|WE_FORGE_|FORGE_)/.test(key)));
  const result = spawnSync(process.execPath, ['--loader', pathToFileURL(loader).href, cli,
    `--repo=${root}`, `--gate=node ${gate}`, '--json'], {
    cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 256 * 1024,
    env: { ...env, WE_TOOLS_ROOT_REEXEC: '1', WE_PLATFORM_PREFERENCES: preferences,
      WE_VERIFY_REVERT_RED: 'off', WE_VERIFY_ALWAYS_RUN_TESTS: '', WE_VERIFY_SKIP_LOCAL_FOR_CARD_ONLY: '0' },
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.signal, result.stderr).toBeNull();
  const verdict = JSON.parse(result.stdout.trim().split('\n').at(-1));
  return { result, verdict, gateStarted, baseStarted,
    marker: JSON.parse(readFileSync(join(root, '.git', '.lane-verify'), 'utf8')),
    events: readFileSync(events, 'utf8').trim().split('\n').map(JSON.parse) };
}

describe('verify-lane admission timeout callers', () => {
  it.each(['acquireAdmission', 'withBaseRerunSlot'])(
    '%s capacity exhaustion exits 3 and never starts the corresponding gate', caller => {
      const probe = runCaller(caller, true);
      expect(probe.result.status, probe.result.stderr).toBe(3);
      expect(probe.verdict).toMatchObject({ status: 'infrastructure-failure', ok: false, reason: 'admission-timeout' });
      expect(probe.verdict.detail).toContain('rerun node scripts/verify-lane.mjs');
      expect(probe.marker).toMatchObject({ status: 'infrastructure-failure', infrastructure: { reason: 'admission-timeout' } });
      expect(probe.events.at(-1)).toMatchObject({ caller, result: { ok: false, timedOut: true } });
      expect(probe.events).toHaveLength(caller === 'acquireAdmission' ? 1 : 2);
      expect(existsSync(probe.gateStarted)).toBe(caller === 'withBaseRerunSlot');
      expect(existsSync(probe.baseStarted)).toBe(false);
    });
  it.each(['acquireAdmission', 'withBaseRerunSlot'])(
    '%s starts the corresponding gate when capacity is available', caller => {
      const probe = runCaller(caller, false);
      expect(probe.result.status, probe.result.stderr).toBe(caller === 'acquireAdmission' ? 0 : 2);
      expect(probe.events.at(-1)).toMatchObject({ caller, result: { ok: true, timedOut: false } });
      expect(existsSync(probe.gateStarted)).toBe(true);
      expect(existsSync(probe.baseStarted)).toBe(caller === 'withBaseRerunSlot');
    });
});
