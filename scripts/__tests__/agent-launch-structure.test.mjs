import { describe, expect, it } from 'vitest';
import { relative, resolve } from 'node:path';
import { AGENT_LAUNCH_ALLOWLIST, findAgentLaunches, readAgentLaunchTree } from '../lib/agent-launch-structure.mjs';

const root = resolve(import.meta.dirname, '../..');
// PR1 baseline: PRs 0f-2..0f-5 must shrink this ALLOWLIST as they migrate launch sites.
// Match file + call kind + exact count; line shifts do not grant new exemptions.
const ALLOWLIST = [
  { file: 'scripts/codex-direct-task.mjs', kind: 'spawnFn', count: 1 },
  { file: 'scripts/conveyor/claude-auth-health.mjs', kind: 'exec', count: 1 },
  { file: 'scripts/conveyor/driver-watchdog.mjs', kind: 'exec', count: 1 },
  { file: 'scripts/conveyor/health-watch.mjs', kind: 'exec', count: 1 },
  { file: 'scripts/conveyor/liveness-sweep.mjs', kind: 'exec', count: 1 },
  { file: 'scripts/conveyor/orphan-claim-release.mjs', kind: 'execFileSync', count: 1 },
  { file: 'scripts/conveyor/pool-exhaustion.mjs', kind: 'execFileSync', count: 1 },
  { file: 'scripts/conveyor/reconcile-pass.mjs', kind: 'exec', count: 1 },
  { file: 'scripts/conveyor/session-reaper.mjs', kind: 'exec', count: 1 },
  { file: 'scripts/conveyor/session-watchdog.mjs', kind: 'exec', count: 1 },
  { file: 'scripts/lane-whois.mjs', kind: 'exec', count: 1 },
  { file: 'scripts/lib/claude-sessions.mjs', kind: 'exec', count: 1 },
  { file: 'scripts/lib/codex-judge-spawn.mjs', kind: 'spawnFn', count: 1 },
  { file: 'scripts/lib/judge-spawn.mjs', kind: 'spawnFn', count: 1 },
  { file: 'scripts/lib/lane-salvage.mjs', kind: 'exec', count: 1 },
  { file: 'scripts/lib/pr-state-io.mjs', kind: 'exec', count: 1 },
  { file: 'scripts/lib/reap-dead-review-runs.mjs', kind: 'listing', count: 1 },
  { file: 'scripts/lib/review-precedents-io.mjs', kind: 'spawn', count: 1 },
  { file: 'scripts/operations/codex-delivery-provider.mjs', kind: 'spawnToCompletion', count: 1 },
  { file: 'scripts/operations/deliver-item-wrapper.mjs', kind: 'runFn', count: 1 },
  { file: 'scripts/operations/dispatch-abort.mjs', kind: 'exec', count: 1 },
  { file: 'scripts/operations/dispatch-lane-io.mjs', kind: 'exec', count: 3 },
  { file: 'scripts/operations/dispatch-lane-io.mjs', kind: 'spawnToCompletion', count: 1 },
  { file: 'scripts/operations/explore-io.mjs', kind: 'exec', count: 2 },
  { file: 'scripts/operations/land-advance-io.mjs', kind: 'run', count: 1 },
  { file: 'scripts/operations/maintenance-io.mjs', kind: 'exec', count: 1 },
  { file: 'scripts/operations/operator-controls-io.mjs', kind: 'execFileSync', count: 1 },
  { file: 'scripts/operations/operator-why-io.mjs', kind: 'run', count: 1 },
  { file: 'scripts/operations/scheduled-sweep.mjs', kind: 'spawnSync', count: 1 },
  { file: 'scripts/operator/dispatch.mjs', kind: 'spawnFn', count: 1 },
  { file: 'scripts/probes/worker-result-probe.mjs', kind: 'run', count: 8 },
];

function assertAllowlist(findings, allowlist) {
  // Parse failures have no call kind and must never be exempted.
  expect(findings.filter(f => !f.kind), 'scanner must establish every call kind').toEqual([]);
  const counts = new Map();
  for (const finding of findings) {
    const key = JSON.stringify({ file: relative(root, finding.file).replaceAll('\\', '/'), kind: finding.kind });
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const inventory = [...counts].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) => ({ ...JSON.parse(key), count }));
  expect(inventory, 'update the migration allowlist: new bypass or stale exemption').toEqual(allowlist);
}

describe('single agent launch boundary', () => {
  it('permits exactly the unmigrated allowlist throughout scripts/ and skills-src/', () => {
    expect(AGENT_LAUNCH_ALLOWLIST).toEqual(['scripts/lib/agent-launch.mjs']);
    assertAllowlist(findAgentLaunches(readAgentLaunchTree(root)), ALLOWLIST);
  }, 60_000);

  const baseline = [{ file: 'scripts/legacy.mjs', kind: 'spawn', count: 1 }];
  it('accepts an exact file, call kind and count match', () => {
    assertAllowlist(findAgentLaunches({ 'scripts/legacy.mjs': "spawn('claude', [])" }), baseline);
  });
  it.each([
    ['new file', { 'skills-src/task/run.mjs': "spawn('claude', [])" }],
    ['new call kind', { 'scripts/legacy.mjs': "exec('claude -p hello')" }],
    ['increased call count', { 'scripts/legacy.mjs': "spawn('claude', []); spawn('codex', [])" }],
    ['removed allowlisted entry', {}],
    ['decreased call count', { 'scripts/legacy.mjs': "spawn('claude', [])" }, [{ ...baseline[0], count: 2 }]],
    ['unparseable source', { 'scripts/broken.mjs': "spawn('claude', [" }],
  ])('fails closed on %s', (_name, sources, allowed = baseline) => {
    expect(() => assertAllowlist(findAgentLaunches(sources), allowed)).toThrow();
  });

  const forbidden = {
    direct: "spawn('claude', ['-p', 'hello'])",
    synchronous: "spawnSync('codex', ['exec', 'hello'])",
    exec: "exec('claude -p hello')",
    execFile: "execFile('claude', ['agents', '--json'])",
    execFileSync: "execFileSync('codex', ['exec', 'hello'])",
    fork: "fork('claude', [])",
    member: "cp.spawn('claude', [])",
    childProcessMember: "child_process.execFile('codex', ['exec'])",
    computedMember: "cp['spawnSync']('claude', [])",
    alias: "const s = spawn; s('claude', [])",
    aliasChain: "const s = cp.spawn; const ss = s; ss('codex', [])",
    importedAlias: "import { spawn as sp } from 'node:child_process'; sp('claude', [])",
    constant: "const CLI = 'claude'; spawn(CLI, [])",
    constantAlias: "const C = 'codex'; const CLI = C; cp.execFile(CLI, [])",
    template: 'spawn(`claude`, [])',
    templateShell: 'spawn("sh", ["-c", `claude -p ${prompt}`])',
    shell: "spawn('sh', ['-c', 'codex exec hello'])",
    shellConstant: "const SCRIPT = 'claude agents --json'; execFile('/bin/bash', ['-lc', SCRIPT])",
    array: "const CMD = ['codex', 'exec']; spawn(CMD[0], CMD.slice(1))",
    arrayCommand: "run(['claude', '-p', 'hello'])",
    runFn: "runFn('claude', ['stop', id])",
    injectedDefault: "function f({ spawnFn = spawn } = {}) { spawnFn('claude', []) }",
    injectedAliasDefault: "function f({ run: r = cp.execFileSync } = {}) { r('codex', ['exec']) }",
    commandDefault: "function f({ cli = 'codex', spawnFn = spawn } = {}) { spawnFn(cli, []) }",
    objectConstant: "const BINS = { primary: 'claude' }; cp.execFile(BINS.primary, [])",
    frozenRegistry: "const BINS = Object.freeze({ codex: 'codex' }); spawnSync(BINS['codex'], [])",
    builder: "function command() { return { cmd: 'claude', args: ['-p'] }; } const { cmd, args } = command(); spawn(cmd, args)",
  };
  it.each(Object.entries(forbidden))('rejects the %s bypass', (_name, source) => {
    expect(findAgentLaunches({ 'scripts/forbidden.mjs': source })).not.toEqual([]);
  });

  it('resolves command constants imported from another file', () => {
    expect(findAgentLaunches({ 'scripts/cli.mjs': "export const CLI = 'claude';",
      'skills-src/task/run.mjs': "import { CLI as bin } from '../../scripts/cli.mjs'; import {spawn as s} from 'node:child_process'; s(bin, [])" })).toHaveLength(1);
  });
  it('fails closed when a source cannot be parsed', () => {
    expect(findAgentLaunches({ 'scripts/broken.mjs': "spawn('claude', [" })).toMatchObject([{ reason: expect.stringContaining('unparseable') }]);
  });
  it('allows unrelated processes, shadowed constants, comments, and launcher calls', () => {
    expect(findAgentLaunches({ 'scripts/ok.mjs': `
      import {launchAgent} from './lib/agent-launch.mjs';
      const CLI = 'claude';
      function f() { const CLI = 'node'; spawn(CLI, ['script.mjs']); }
      // cp.spawn('claude', [])
      const help = "run('codex', ['exec'])";
      launchAgent({mode: 'claude-print', resumeId: null}, spawn, CLI, ['-p', 'hi']);
    ` })).toEqual([]);
  });
});
